"""한국어 최종 전사를 들린 음성에 가깝게 수행하는 faster-whisper 디코더 래퍼."""

from __future__ import annotations

import argparse
import inspect
from dataclasses import asdict, is_dataclass
from typing import Any, Callable

DEFAULT_FINAL_DECODER = "literal"
DEFAULT_FINAL_BEAM_SIZE = 5
DEFAULT_FINAL_PATIENCE = 1.0
DEFAULT_FINAL_REPETITION_PENALTY = 1.1
DEFAULT_FINAL_MIN_SILENCE_DURATION_MS = 700
DEFAULT_FINAL_SPEECH_PAD_MS = 350
DEFAULT_CONTEXTUAL_PROMPT = (
    "이 음성은 한국어 회의 녹음입니다. 참석자들의 발언을 자연스러운 한글 문장으로 받아씁니다. "
    "회의에서 쓰이는 이름, 직책, 일정, 숫자, 결정사항, 업무 용어를 가능한 한 정확히 적습니다."
)

ProgressEmitter = Callable[[str, int, str], None]


def add_quality_args(parser: argparse.ArgumentParser) -> None:
    """최종 전사의 직청/문맥 보정 방식을 조절하는 CLI 옵션을 추가한다."""

    parser.add_argument(
        "--final-decoder",
        choices=("fast", "literal", "accurate", "contextual"),
        default=DEFAULT_FINAL_DECODER,
        help="최종 전사 디코더. literal은 들린 음성 우선, contextual은 문맥 보정 사용",
    )
    parser.add_argument("--final-beam-size", type=int, default=DEFAULT_FINAL_BEAM_SIZE, help="최종 전사 beam search 폭")
    parser.add_argument("--final-patience", type=float, default=DEFAULT_FINAL_PATIENCE, help="최종 전사 beam search patience")
    parser.add_argument(
        "--final-repetition-penalty",
        type=float,
        default=DEFAULT_FINAL_REPETITION_PENALTY,
        help="반복 문장 억제 강도",
    )
    parser.add_argument(
        "--final-min-silence-duration-ms",
        type=int,
        default=DEFAULT_FINAL_MIN_SILENCE_DURATION_MS,
        help="최종 전사 VAD가 발화를 나누는 최소 무음 길이",
    )
    parser.add_argument(
        "--final-speech-pad-ms",
        type=int,
        default=DEFAULT_FINAL_SPEECH_PAD_MS,
        help="최종 전사 VAD가 발화 앞뒤에 보존할 여유 길이",
    )
    parser.add_argument("--initial-prompt", help="문맥 보정이 필요할 때만 쓰는 전사 힌트 문장")
    parser.add_argument("--hotwords", help="전사에서 우선 고려할 회사명, 제품명, 참석자명 등 쉼표 구분 키워드")


def should_use_standard_decoder(args: argparse.Namespace) -> bool:
    """표준 디코더가 필요한 요청인지 확인한다."""

    if args.final_decoder == "fast":
        return False

    if getattr(args, "transcribe_only", False):
        return bool(getattr(args, "standard_decoder_for_transcribe_only", False))

    return True


def is_contextual_decoder(args: argparse.Namespace) -> bool:
    """의미 보정이 들어가는 문맥형 전사인지 확인한다."""

    return args.final_decoder == "contextual"


def get_initial_prompt(args: argparse.Namespace) -> str | None:
    """기본 literal 모드에서는 프롬프트를 쓰지 않아 문장 추론 편향을 줄인다."""

    if args.initial_prompt:
        return args.initial_prompt

    if is_contextual_decoder(args):
        return DEFAULT_CONTEXTUAL_PROMPT

    return None


def build_final_vad_parameters(args: argparse.Namespace) -> dict[str, Any]:
    """멀리 있는 한국어 발화가 잘리지 않도록 표준 디코더용 VAD 값을 만든다."""

    return {
        "threshold": args.vad_onset,
        "neg_threshold": args.vad_offset,
        "min_speech_duration_ms": 80,
        "min_silence_duration_ms": args.final_min_silence_duration_ms,
        "speech_pad_ms": args.final_speech_pad_ms,
    }


def transcribe_audio_with_standard_decoder(
    model: Any,
    audio: Any,
    args: argparse.Namespace,
    emit_progress: ProgressEmitter,
) -> dict[str, Any]:
    """로드된 Whisper 모델의 표준 디코더로 최종 전사를 수행한다."""

    emit_progress("transcribe", 25, "직청 우선 전사를 시작하는 중")
    standard_model = getattr(model, "model", model)
    use_context = is_contextual_decoder(args)
    segments_iterable, info = call_with_supported_kwargs(
        standard_model.transcribe,
        audio,
        language=args.language,
        task=args.task,
        beam_size=args.final_beam_size,
        best_of=5,
        patience=args.final_patience,
        length_penalty=1.0,
        repetition_penalty=args.final_repetition_penalty,
        no_repeat_ngram_size=0,
        temperature=[0.0, 0.2, 0.4] if use_context else 0.0,
        compression_ratio_threshold=2.4,
        log_prob_threshold=args.log_prob_threshold,
        no_speech_threshold=args.no_speech_threshold,
        condition_on_previous_text=use_context,
        prompt_reset_on_temperature=0.5,
        initial_prompt=get_initial_prompt(args),
        suppress_blank=True,
        suppress_tokens=[-1],
        without_timestamps=False,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters=build_final_vad_parameters(args),
        hallucination_silence_threshold=args.hallucination_silence_threshold,
        hotwords=args.hotwords,
    )
    segments = collect_segments(segments_iterable, info, emit_progress)

    return {
        "segments": segments,
        "language": getattr(info, "language", args.language),
        "_audio": audio,
    }


def collect_segments(segments_iterable: Any, info: Any, emit_progress: ProgressEmitter) -> list[dict[str, Any]]:
    """faster-whisper Segment 제너레이터를 앱에서 쓰는 dict 목록으로 변환한다."""

    segments: list[dict[str, Any]] = []
    duration = max(float(getattr(info, "duration", 0.0) or 0.0), 0.1)

    for raw_segment in segments_iterable:
        segments.append(segment_to_dict(raw_segment))
        progress = min(60, 25 + int((float(raw_segment.end) / duration) * 35))
        emit_progress("transcribe", progress, "직청 우선 전사 진행 중")

    emit_progress("transcribe", 60, "텍스트 변환 완료")
    return segments


def call_with_supported_kwargs(function: Any, *args: Any, **kwargs: Any) -> Any:
    """설치된 faster-whisper 버전이 지원하는 인자만 넘겨 호환성을 지킨다."""

    signature = inspect.signature(function)
    supported_kwargs = {
        key: value
        for key, value in kwargs.items()
        if key in signature.parameters and value is not None
    }
    return function(*args, **supported_kwargs)


def segment_to_dict(segment: Any) -> dict[str, Any]:
    """faster-whisper Segment 객체를 WhisperX 결과와 비슷한 dict로 바꾼다."""

    words = [word_to_dict(word) for word in (segment.words or [])]

    return {
        "text": segment.text,
        "start": float(segment.start),
        "end": float(segment.end),
        "avg_logprob": float(segment.avg_logprob),
        "score": score_from_words(words),
        "words": words,
    }


def word_to_dict(word: Any) -> dict[str, Any]:
    """단어 타임스탬프 객체의 필드를 앱 후처리에서 쓰는 키로 정규화한다."""

    source = asdict(word) if is_dataclass(word) else word
    value = source if isinstance(source, dict) else vars(source)
    probability = float(value.get("probability", value.get("score", 0.0)) or 0.0)

    return {
        "start": float(value.get("start", 0.0) or 0.0),
        "end": float(value.get("end", 0.0) or 0.0),
        "word": str(value.get("word", "") or ""),
        "score": probability,
    }


def score_from_words(words: list[dict[str, Any]]) -> float:
    """단어별 확률 평균을 구해 구간 confidence로 사용한다."""

    scores = [float(word["score"]) for word in words if word.get("score") is not None]

    if not scores:
        return 0.0

    return round(sum(scores) / len(scores), 4)
