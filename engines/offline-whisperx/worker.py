#!/usr/bin/env python3
"""WhisperX와 sherpa-onnx를 이용해 로컬 전사/화자분리를 수행한다."""

from __future__ import annotations

import argparse
import inspect
import json
import os
import re
import sys
import traceback
import warnings
from typing import Any

from diarization import (
    DEFAULT_DIARIZATION_MERGE_GAP_MS,
    DEFAULT_DIARIZATION_MIN_TURN_MS,
    DEFAULT_DIARIZATION_OVERLAP_BRIDGE_GAP_MS,
    DEFAULT_DIARIZATION_OVERLAP_MIN_TURN_MS,
    DEFAULT_DIARIZATION_OVERLAP_PADDING_MS,
    DiarizedTurn,
    build_speakers,
    diarize_audio,
    find_overlap_regions,
    get_overlap_group,
    get_speaker_label,
)
from quality_transcription import (
    add_quality_args,
    should_use_standard_decoder,
    transcribe_audio_with_standard_decoder,
)

DEFAULT_LANGUAGE = "ko"
DEFAULT_TASK = "transcribe"
DEFAULT_CLUSTER_THRESHOLD = 0.5
SENTENCE_BOUNDARY_PATTERN = re.compile(r"[^.!?。！？…]+[.!?。！？…]*")
SENTENCE_BOUNDARY_CHARS = ".!?。！？…"
# 화자분리를 건너뛰거나 실패한 미리보기 fallback에서는 고정 화자로 표시한다.
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
    parser.add_argument(
        "--diarization-min-turn-ms",
        type=float,
        default=DEFAULT_DIARIZATION_MIN_TURN_MS,
        help="이 길이보다 짧은 화자 턴은 주변 문맥으로 보정",
    )
    parser.add_argument(
        "--diarization-merge-gap-ms",
        type=float,
        default=DEFAULT_DIARIZATION_MERGE_GAP_MS,
        help="같은 화자 턴을 합칠 최대 공백",
    )
    parser.add_argument(
        "--diarization-overlap-min-turn-ms",
        type=float,
        default=DEFAULT_DIARIZATION_OVERLAP_MIN_TURN_MS,
        help="동시 발화 후보로 보존할 최소 화자 턴 길이",
    )
    parser.add_argument(
        "--diarization-overlap-bridge-gap-ms",
        type=float,
        default=DEFAULT_DIARIZATION_OVERLAP_BRIDGE_GAP_MS,
        help="짧은 화자 전환을 동시 발화 후보로 묶을 최대 공백",
    )
    parser.add_argument(
        "--diarization-overlap-padding-ms",
        type=float,
        default=DEFAULT_DIARIZATION_OVERLAP_PADDING_MS,
        help="동시 발화 후보 경계에 더할 표시 여유 시간",
    )
    parser.add_argument("--batch-size", type=int, default=4, help="WhisperX 배치 크기")
    parser.add_argument("--threads", type=int, help="CPU 추론 스레드 수")
    parser.add_argument("--transcribe-only", action="store_true", help="화자분리 없이 전사 결과만 반환")
    parser.add_argument("--progress", action="store_true", help="stdout에 진행률 JSON 이벤트를 출력")
    parser.add_argument("--no-speech-threshold", type=float, default=0.5, help="무음으로 판단할 no-speech 확률 기준")
    parser.add_argument("--log-prob-threshold", type=float, default=-0.9, help="낮은 신뢰도 전사를 버릴 로그 확률 기준")
    parser.add_argument("--hallucination-silence-threshold", type=float, default=1.0, help="무음 주변 환각 전사 제거 기준")
    parser.add_argument("--vad-onset", type=float, default=0.35, help="VAD 발화 시작 민감도")
    parser.add_argument("--vad-offset", type=float, default=0.25, help="VAD 발화 종료 민감도")
    parser.add_argument("--enable-align", action="store_true", help="외부 alignment 모델을 사용해 단어 타임스탬프를 보정")
    parser.add_argument("--offline-only", action="store_true", help="로컬 캐시 모델만 사용")
    add_quality_args(parser)
    return parser.parse_args()


def emit_progress(args: argparse.Namespace, stage: str, progress: int, message: str) -> None:
    """Electron 메인 프로세스가 읽을 수 있도록 진행률 이벤트를 한 줄 JSON으로 출력한다."""

    if not args.progress:
        return

    print(
        json.dumps(
            {
                "type": "progress",
                "stage": stage,
                "progress": progress,
                "message": message,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )


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


def build_asr_options(args: argparse.Namespace) -> dict[str, Any]:
    """무음이나 잡음을 문장으로 착각하지 않도록 ASR 디코딩 기준을 조정한다."""

    return {
        "condition_on_previous_text": False,
        "no_speech_threshold": args.no_speech_threshold,
        "log_prob_threshold": args.log_prob_threshold,
        "hallucination_silence_threshold": args.hallucination_silence_threshold,
    }


def build_vad_options(args: argparse.Namespace) -> dict[str, Any]:
    """멀리 있는 발화도 잡되 무음 구간은 잘라낼 수 있도록 VAD 기준을 설정한다."""

    return {
        "vad_onset": args.vad_onset,
        "vad_offset": args.vad_offset,
    }


def transcribe_audio(whisperx: Any, args: argparse.Namespace) -> dict[str, Any]:
    """WhisperX로 음성을 텍스트와 단어 타임스탬프로 변환한다."""

    emit_progress(args, "model", 8, "전사 모델을 불러오는 중")
    model = call_with_supported_kwargs(
        whisperx.load_model,
        args.model,
        args.device,
        compute_type=args.compute_type,
        language=args.language,
        download_root=args.model_dir,
        local_files_only=args.offline_only,
        threads=args.threads,
        asr_options=build_asr_options(args),
        vad_options=build_vad_options(args),
    )
    emit_progress(args, "audio", 20, "오디오를 분석하는 중")
    audio = whisperx.load_audio(args.audio)
    if should_use_standard_decoder(args):
        return transcribe_audio_with_standard_decoder(
            model,
            audio,
            args,
            lambda stage, progress, message: emit_progress(args, stage, progress, message),
        )

    emit_progress(args, "transcribe", 25, "음성을 텍스트로 변환하는 중")
    result = call_with_supported_kwargs(
        model.transcribe,
        audio,
        batch_size=args.batch_size,
        language=args.language,
        task=args.task,
    )
    emit_progress(args, "transcribe", 60, "텍스트 변환 완료")
    result["_audio"] = audio
    return result


def align_words(whisperx: Any, result: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    """가능하면 언어별 alignment 모델로 단어 타임스탬프를 보정한다."""

    if not args.enable_align:
        emit_progress(args, "align", 68, "단어 시간 보정을 건너뜀")
        return result

    language = result.get("language") or args.language

    if not language:
        emit_progress(args, "align", 68, "단어 시간 보정을 건너뜀")
        return result

    try:
        emit_progress(args, "align", 64, "단어 시간을 보정하는 중")
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
        emit_progress(args, "align", 70, "단어 시간 보정 완료")
        return aligned_result
    except Exception as error:
        print(f"단어 alignment를 건너뜁니다: {error}", file=sys.stderr)
        emit_progress(args, "align", 68, "단어 시간 보정을 건너뜀")
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


def split_text_sentences(text: str) -> list[str]:
    """문장 부호를 기준으로 전사 텍스트를 표시/재생 가능한 문장 단위로 나눈다."""

    normalized_text = text.strip()

    if not normalized_text:
        return []

    sentences = [match.group(0).strip() for match in SENTENCE_BOUNDARY_PATTERN.finditer(normalized_text)]
    return sentences or [normalized_text]


def append_text_segments(
    segments: list[dict[str, Any]],
    speaker_id: str,
    start: float,
    end: float,
    text: str,
    confidence: float,
    overlap_group_id: str | None,
) -> None:
    """타임스탬프가 단어별로 없을 때 텍스트 문장 길이에 비례해 시간을 나눠 추가한다."""

    sentences = split_text_sentences(text)

    if len(sentences) <= 1:
        append_segment(segments, speaker_id, start, end, text, confidence, overlap_group_id)
        return

    total_weight = sum(max(1, len(sentence)) for sentence in sentences)
    duration = max(0.0, end - start)
    cursor = start

    for index, sentence in enumerate(sentences):
        if index == len(sentences) - 1:
            sentence_end = end
        else:
            sentence_end = cursor + duration * (max(1, len(sentence)) / total_weight)

        append_segment(segments, speaker_id, cursor, sentence_end, sentence, confidence, overlap_group_id)
        cursor = sentence_end


def is_sentence_boundary_word(word: dict[str, Any]) -> bool:
    """Whisper 단어 조각이 문장을 끝내는지 확인한다."""

    return normalize_word_text(word).rstrip().endswith(tuple(SENTENCE_BOUNDARY_CHARS))


def split_words_by_sentence(words: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """단어 타임스탬프를 보존하면서 문장 부호 기준으로 단어 그룹을 나눈다."""

    groups: list[list[dict[str, Any]]] = []
    current_group: list[dict[str, Any]] = []

    for word in words:
        current_group.append(word)

        if is_sentence_boundary_word(word):
            groups.append(current_group)
            current_group = []

    if current_group:
        groups.append(current_group)

    return groups


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
            append_text_segments(
                segments,
                speaker_id,
                start,
                end,
                str(raw_segment.get("text") or ""),
                float(raw_segment.get("score") or 0.0),
                overlap_group_id,
            )
            continue

        for sentence_words in split_words_by_sentence(words):
            start = float(sentence_words[0].get("start", raw_segment.get("start", 0.0)))
            end = float(sentence_words[-1].get("end", start))
            speaker_label = get_speaker_label(start, end, turns)
            speaker_id = label_to_id.get(speaker_label, fallback_speaker_id)
            overlap_group_id = get_overlap_group(start, end, overlaps)
            append_segment(
                segments,
                speaker_id,
                start,
                end,
                join_word_text(sentence_words),
                score_from_words(sentence_words),
                overlap_group_id,
            )

    return segments


def build_output(result: dict[str, Any], turns: list[DiarizedTurn], args: argparse.Namespace | None = None) -> dict[str, Any]:
    """전사 결과, 화자 목록, 겹침 발화 표시를 최종 JSON으로 조립한다."""

    overlaps = find_overlap_regions(turns, args)
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
        append_text_segments(
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
        emit_progress(args, "prepare", 3, "전사 엔진을 준비하는 중")
        whisperx = import_engine_modules()
        result = transcribe_audio(whisperx, args)
        if args.transcribe_only:
            print(json.dumps(build_transcription_only_output(result), ensure_ascii=False))
            return 0

        result = align_words(whisperx, result, args)
        emit_progress(args, "diarize", 72, "화자를 분리하는 중")
        turns = diarize_audio(result["_audio"], args)
        emit_progress(args, "diarize", 90, "화자 분리 완료")
        emit_progress(args, "save", 96, "전사 결과를 정리하는 중")
        print(json.dumps(build_output(result, turns, args), ensure_ascii=False))
        return 0
    except Exception as error:
        print(str(error), file=sys.stderr)
        if os.environ.get("MEETING_RECORDER_STT_DEBUG") == "1":
            traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
