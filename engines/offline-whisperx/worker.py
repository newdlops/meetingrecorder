#!/usr/bin/env python3
"""WhisperX와 pyannote.audio를 이용해 로컬 전사/화자분리를 수행한다."""

from __future__ import annotations

import argparse
import inspect
import json
import os
import sys
import traceback
from dataclasses import dataclass
from typing import Any


SPEAKER_COLORS = ["#1f7a8c", "#b45f06", "#4f6f52", "#6d597a", "#607d8b", "#8a5a44"]
DEFAULT_LANGUAGE = "ko"
DEFAULT_TASK = "transcribe"


@dataclass(frozen=True)
class DiarizedTurn:
    """pyannote가 반환한 화자 발화 구간을 앱에서 쓰기 쉬운 형태로 보관한다."""

    start: float
    end: float
    speaker_label: str


@dataclass(frozen=True)
class OverlapRegion:
    """서로 다른 두 화자의 발화 시간이 겹친 구간을 표현한다."""

    start: float
    end: float
    group_id: str


def parse_args() -> argparse.Namespace:
    """Electron 메인 프로세스가 넘긴 worker 실행 옵션을 읽는다."""

    parser = argparse.ArgumentParser(description="Offline WhisperX transcription worker")
    parser.add_argument("--audio", required=True, help="전사할 오디오 파일 경로")
    parser.add_argument("--model", default="large-v3", help="Whisper 모델 이름")
    parser.add_argument("--device", default="cpu", help="cpu 또는 cuda")
    parser.add_argument("--compute-type", default="int8", help="float16, float32, int8 등")
    parser.add_argument("--language", default=DEFAULT_LANGUAGE, help="언어 코드. 한국어는 ko")
    parser.add_argument(
        "--task",
        choices=("transcribe", "translate"),
        default=DEFAULT_TASK,
        help="전사는 transcribe, 영어 번역은 translate",
    )
    parser.add_argument("--hf-token", help="pyannote 모델 접근용 Hugging Face token")
    parser.add_argument("--model-dir", help="모델 캐시 디렉터리")
    parser.add_argument("--min-speakers", type=int, help="예상 최소 화자 수")
    parser.add_argument("--max-speakers", type=int, help="예상 최대 화자 수")
    parser.add_argument("--batch-size", type=int, default=4, help="WhisperX 배치 크기")
    parser.add_argument("--offline-only", action="store_true", help="로컬 캐시 모델만 사용")
    return parser.parse_args()


def import_engine_modules() -> Any:
    """필수 Python 패키지를 불러오고 없으면 설치 안내가 가능한 오류를 낸다."""

    try:
      import whisperx  # type: ignore
    except ImportError as error:
        raise RuntimeError(
            "오프라인 전사 엔진 의존성이 없습니다. "
            "`pip install -r engines/offline-whisperx/requirements.txt`를 실행하세요."
        ) from error

    return whisperx


def configure_offline_mode(enabled: bool) -> None:
    """완전 오프라인 실행 시 Hugging Face/transformers가 네트워크를 쓰지 않도록 설정한다."""

    if not enabled:
        return

    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"


def call_with_supported_kwargs(function: Any, *args: Any, **kwargs: Any) -> Any:
    """설치된 WhisperX 버전에 존재하는 키워드 인자만 넘겨 호환성을 높인다."""

    signature = inspect.signature(function)
    supported_kwargs = {
        key: value
        for key, value in kwargs.items()
        if value is not None and key in signature.parameters
    }
    return function(*args, **supported_kwargs)


def transcribe_audio(whisperx: Any, args: argparse.Namespace) -> dict[str, Any]:
    """WhisperX로 음성을 텍스트와 단어 타임스탬프로 변환한다."""

    model = call_with_supported_kwargs(
        whisperx.load_model,
        args.model,
        args.device,
        compute_type=args.compute_type,
        language=args.language,
        download_root=args.model_dir,
        local_files_only=args.offline_only,
    )
    audio = whisperx.load_audio(args.audio)
    result = call_with_supported_kwargs(
        model.transcribe,
        audio,
        batch_size=args.batch_size,
        language=args.language,
        task=args.task,
    )
    result["_audio"] = audio
    return result


def align_words(whisperx: Any, result: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    """가능하면 언어별 alignment 모델로 단어 타임스탬프를 보정한다."""

    language = result.get("language") or args.language

    if not language:
        return result

    try:
        model, metadata = call_with_supported_kwargs(
            whisperx.load_align_model,
            language_code=language,
            device=args.device,
            model_dir=args.model_dir,
        )
        aligned_result = whisperx.align(
            result["segments"],
            model,
            metadata,
            result["_audio"],
            args.device,
            return_char_alignments=False,
        )
        aligned_result["_audio"] = result["_audio"]
        aligned_result["language"] = language
        return aligned_result
    except Exception as error:
        print(f"단어 alignment를 건너뜁니다: {error}", file=sys.stderr)
        return result


def diarize_audio(whisperx: Any, args: argparse.Namespace) -> Any:
    """pyannote 기반 화자분리 파이프라인을 실행한다."""

    from whisperx.diarize import DiarizationPipeline  # type: ignore

    pipeline = DiarizationPipeline(token=args.hf_token, device=args.device)
    diarize_kwargs = {
        "min_speakers": args.min_speakers,
        "max_speakers": args.max_speakers,
    }
    return call_with_supported_kwargs(pipeline, args.audio, **diarize_kwargs)


def extract_diarized_turns(diarization: Any) -> list[DiarizedTurn]:
    """pyannote Annotation 객체에서 시간/화자 라벨만 뽑아낸다."""

    turns: list[DiarizedTurn] = []

    for turn, _, speaker_label in diarization.itertracks(yield_label=True):
        turns.append(
            DiarizedTurn(
                start=float(turn.start),
                end=float(turn.end),
                speaker_label=str(speaker_label),
            )
        )

    return sorted(turns, key=lambda item: (item.start, item.end, item.speaker_label))


def find_overlap_regions(turns: list[DiarizedTurn]) -> list[OverlapRegion]:
    """서로 다른 화자 발화가 시간상 겹치는 구간 목록을 만든다."""

    regions: list[OverlapRegion] = []

    for left_index, left in enumerate(turns):
        for right in turns[left_index + 1 :]:
            if right.start >= left.end:
                break

            if left.speaker_label == right.speaker_label:
                continue

            start = max(left.start, right.start)
            end = min(left.end, right.end)

            if start < end:
                regions.append(OverlapRegion(start=start, end=end, group_id=f"overlap-{len(regions) + 1}"))

    return regions


def build_speakers(turns: list[DiarizedTurn]) -> tuple[list[dict[str, str]], dict[str, str]]:
    """pyannote 화자 라벨을 앱의 speakerId와 표시 이름으로 변환한다."""

    labels = sorted({turn.speaker_label for turn in turns})

    if not labels:
        labels = ["SPEAKER_00"]

    label_to_id = {label: f"speaker-{index + 1}" for index, label in enumerate(labels)}
    speakers = [
        {
            "id": label_to_id[label],
            "name": f"화자 {index + 1}",
            "color": SPEAKER_COLORS[index % len(SPEAKER_COLORS)],
        }
        for index, label in enumerate(labels)
    ]
    return speakers, label_to_id


def get_overlap_group(start: float, end: float, regions: list[OverlapRegion]) -> str | None:
    """전사 구간이 겹침 발화 구간과 만나는지 확인하고 그룹 ID를 돌려준다."""

    for region in regions:
        if start < region.end and end > region.start:
            return region.group_id

    return None


def score_from_words(words: list[dict[str, Any]]) -> float:
    """단어별 confidence가 있으면 평균값을 구하고 없으면 기본값을 쓴다."""

    scores = [float(word["score"]) for word in words if "score" in word and word["score"] is not None]

    if not scores:
        return 0.0

    return round(sum(scores) / len(scores), 4)


def normalize_word_text(word: dict[str, Any]) -> str:
    """WhisperX 단어 객체에서 출력 가능한 텍스트만 정리한다."""

    return str(word.get("word") or "").strip()


def join_word_text(words: list[dict[str, Any]]) -> str:
    """한국어 공백 손상을 줄이기 위해 모델이 준 단어 조각의 원래 공백을 최대한 보존한다."""

    raw_text = "".join(str(word.get("word") or "") for word in words).strip()

    if raw_text:
        return raw_text

    return " ".join(normalize_word_text(word) for word in words)


def append_segment(
    segments: list[dict[str, Any]],
    speaker_id: str,
    start: float,
    end: float,
    text: str,
    confidence: float,
    overlap_group_id: str | None,
) -> None:
    """앱이 이해하는 TranscriptSegment 형식으로 구간 하나를 추가한다."""

    if not text.strip():
        return

    segments.append(
        {
            "id": f"segment-{len(segments) + 1}",
            "speakerId": speaker_id,
            "startMs": int(round(start * 1000)),
            "endMs": int(round(end * 1000)),
            "text": text.strip(),
            "confidence": confidence,
            "isOverlapped": overlap_group_id is not None,
            "overlapGroupId": overlap_group_id,
        }
    )


def build_segments(
    result: dict[str, Any],
    label_to_id: dict[str, str],
    overlaps: list[OverlapRegion],
) -> list[dict[str, Any]]:
    """WhisperX 결과를 앱의 전사 구간 목록으로 변환한다."""

    segments: list[dict[str, Any]] = []
    fallback_speaker_id = next(iter(label_to_id.values()))

    for raw_segment in result.get("segments", []):
        words = [word for word in raw_segment.get("words", []) if normalize_word_text(word)]

        if not words:
            start = float(raw_segment.get("start", 0.0))
            end = float(raw_segment.get("end", start))
            speaker_label = str(raw_segment.get("speaker") or "")
            speaker_id = label_to_id.get(speaker_label, fallback_speaker_id)
            overlap_group_id = get_overlap_group(start, end, overlaps)
            append_segment(
                segments,
                speaker_id,
                start,
                end,
                str(raw_segment.get("text") or ""),
                float(raw_segment.get("score") or 0.0),
                overlap_group_id,
            )
            continue

        current_words: list[dict[str, Any]] = []
        current_speaker_label = str(words[0].get("speaker") or raw_segment.get("speaker") or "")

        for word in words:
            word_speaker_label = str(word.get("speaker") or raw_segment.get("speaker") or current_speaker_label)

            if current_words and word_speaker_label != current_speaker_label:
                flush_word_group(segments, current_words, current_speaker_label, label_to_id, fallback_speaker_id, overlaps)
                current_words = []

            current_speaker_label = word_speaker_label
            current_words.append(word)

        if current_words:
            flush_word_group(segments, current_words, current_speaker_label, label_to_id, fallback_speaker_id, overlaps)

    return segments


def flush_word_group(
    segments: list[dict[str, Any]],
    words: list[dict[str, Any]],
    speaker_label: str,
    label_to_id: dict[str, str],
    fallback_speaker_id: str,
    overlaps: list[OverlapRegion],
) -> None:
    """같은 화자로 묶인 단어들을 하나의 전사 구간으로 합친다."""

    start = float(words[0].get("start", 0.0))
    end = float(words[-1].get("end", start))
    text = join_word_text(words)
    speaker_id = label_to_id.get(speaker_label, fallback_speaker_id)
    overlap_group_id = get_overlap_group(start, end, overlaps)
    append_segment(segments, speaker_id, start, end, text, score_from_words(words), overlap_group_id)


def build_output(whisperx: Any, result: dict[str, Any], diarization: Any) -> dict[str, Any]:
    """전사 결과, 화자 목록, 겹침 발화 표시를 최종 JSON으로 조립한다."""

    assigned = whisperx.assign_word_speakers(diarization, result)
    turns = extract_diarized_turns(diarization)
    overlaps = find_overlap_regions(turns)
    speakers, label_to_id = build_speakers(turns)
    segments = build_segments(assigned, label_to_id, overlaps)
    duration_ms = max((segment["endMs"] for segment in segments), default=0)

    return {
        "engineName": "whisperx-pyannote-local",
        "language": assigned.get("language") or result.get("language"),
        "durationMs": duration_ms,
        "speakers": speakers,
        "segments": segments,
    }


def main() -> int:
    """worker 전체 실행 흐름을 조율하고 stdout에 JSON만 출력한다."""

    args = parse_args()
    configure_offline_mode(args.offline_only)

    try:
        whisperx = import_engine_modules()
        result = transcribe_audio(whisperx, args)
        result = align_words(whisperx, result, args)
        diarization = diarize_audio(whisperx, args)
        print(json.dumps(build_output(whisperx, result, diarization), ensure_ascii=False))
        return 0
    except Exception as error:
        print(str(error), file=sys.stderr)
        if os.environ.get("MEETING_RECORDER_STT_DEBUG") == "1":
            traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
