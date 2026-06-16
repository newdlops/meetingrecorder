#!/usr/bin/env python3
"""WhisperX와 sherpa-onnx를 이용해 로컬 전사/화자분리를 수행한다."""

from __future__ import annotations

import argparse
import inspect
import json
import os
import sys
import traceback
import warnings
from typing import Any

from diarization import (
    DiarizedTurn,
    build_speakers,
    diarize_audio,
    find_overlap_regions,
    get_overlap_group,
    get_speaker_label,
)

DEFAULT_LANGUAGE = "ko"
DEFAULT_TASK = "transcribe"
DEFAULT_CLUSTER_THRESHOLD = 0.5
# 미리보기 전사는 아직 화자분리를 하지 않으므로 고정 화자로 표시한다.
PREVIEW_SPEAKER = {"id": "speaker-preview", "name": "미리보기", "color": "#607d8b"}

warnings.filterwarnings("ignore", message=r"\s*torchcodec is not installed correctly.*")
warnings.filterwarnings("ignore", category=UserWarning, module=r"pyannote\.audio\.core\.io")


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
    parser.add_argument("--model-dir", help="모델 캐시 디렉터리")
    parser.add_argument("--asset-root", help="앱에 포함된 엔진 모델 자산 루트")
    parser.add_argument("--diarization-segmentation-model", help="sherpa-onnx 화자 segmentation ONNX 경로")
    parser.add_argument("--diarization-embedding-model", help="sherpa-onnx speaker embedding ONNX 경로")
    parser.add_argument("--num-speakers", type=int, default=-1, help="알고 있는 화자 수. 모르면 -1")
    parser.add_argument("--cluster-threshold", type=float, default=DEFAULT_CLUSTER_THRESHOLD, help="화자 클러스터링 임계값")
    parser.add_argument("--min-speakers", type=int, help="예상 최소 화자 수")
    parser.add_argument("--max-speakers", type=int, help="예상 최대 화자 수")
    parser.add_argument("--batch-size", type=int, default=4, help="WhisperX 배치 크기")
    parser.add_argument("--threads", type=int, help="CPU 추론 스레드 수")
    parser.add_argument("--transcribe-only", action="store_true", help="화자분리 없이 전사 결과만 반환")
    parser.add_argument("--enable-align", action="store_true", help="외부 alignment 모델을 사용해 단어 타임스탬프를 보정")
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

    whisperx.setup_logging("error")
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
    has_keyword_args = any(
        parameter.kind == inspect.Parameter.VAR_KEYWORD
        for parameter in signature.parameters.values()
    )

    if has_keyword_args:
        supported_kwargs = {key: value for key, value in kwargs.items() if value is not None}
        return function(*args, **supported_kwargs)

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
        threads=args.threads,
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

    if not args.enable_align:
        return result

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
    turns: list[DiarizedTurn],
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
            speaker_label = get_speaker_label(start, end, turns)
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
        first_start = float(words[0].get("start", raw_segment.get("start", 0.0)))
        first_end = float(words[0].get("end", first_start))
        current_speaker_label = get_speaker_label(first_start, first_end, turns)

        for word in words:
            word_start = float(word.get("start", raw_segment.get("start", 0.0)))
            word_end = float(word.get("end", word_start))
            word_speaker_label = get_speaker_label(word_start, word_end, turns)

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


def build_output(result: dict[str, Any], turns: list[DiarizedTurn]) -> dict[str, Any]:
    """전사 결과, 화자 목록, 겹침 발화 표시를 최종 JSON으로 조립한다."""

    overlaps = find_overlap_regions(turns)
    speakers, label_to_id = build_speakers(turns)
    segments = build_segments(result, turns, label_to_id, overlaps)
    duration_ms = max((segment["endMs"] for segment in segments), default=0)

    return {
        "engineName": "whisperx-sherpa-onnx-local",
        "language": result.get("language"),
        "durationMs": duration_ms,
        "speakers": speakers,
        "segments": segments,
    }


def build_transcription_only_output(result: dict[str, Any]) -> dict[str, Any]:
    """녹음 중 미리보기용으로 화자분리 없이 Whisper 구간만 앱 형식으로 변환한다."""

    segments: list[dict[str, Any]] = []

    for raw_segment in result.get("segments", []):
        start = float(raw_segment.get("start", 0.0))
        end = float(raw_segment.get("end", start))
        append_segment(
            segments,
            PREVIEW_SPEAKER["id"],
            start,
            end,
            str(raw_segment.get("text") or ""),
            float(raw_segment.get("score") or 0.0),
            None,
        )

    duration_ms = max((segment["endMs"] for segment in segments), default=0)

    return {
        "engineName": "whisperx-local-preview",
        "language": result.get("language"),
        "durationMs": duration_ms,
        "speakers": [PREVIEW_SPEAKER],
        "segments": segments,
    }


def main() -> int:
    """worker 전체 실행 흐름을 조율하고 마지막 stdout 라인에 JSON을 출력한다."""

    args = parse_args()
    configure_offline_mode(args.offline_only)

    try:
        whisperx = import_engine_modules()
        result = transcribe_audio(whisperx, args)
        if args.transcribe_only:
            print(json.dumps(build_transcription_only_output(result), ensure_ascii=False))
            return 0

        result = align_words(whisperx, result, args)
        turns = diarize_audio(result["_audio"], args)
        print(json.dumps(build_output(result, turns), ensure_ascii=False))
        return 0
    except Exception as error:
        print(str(error), file=sys.stderr)
        if os.environ.get("MEETING_RECORDER_STT_DEBUG") == "1":
            traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
