"""whisper.cpp CLI를 기존 WhisperX 결과 형태로 변환하는 어댑터."""

from __future__ import annotations

import argparse
import json
import os
import re
import struct
import subprocess
import tempfile
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from quality_transcription import get_initial_prompt, is_contextual_decoder

ProgressEmitter = Callable[[str, int, str], None]

TIMESTAMP_PATTERN = re.compile(r"(?:(\d+):)?(\d+):(\d+)(?:[.,](\d+))?")
SPECIAL_TOKEN_PATTERN = re.compile(r"^<\|.*\|>$")
ACOUSTIC_FRAME_MS = 20
DEFAULT_SILENCE_RMS_THRESHOLD = 0.0025
DEFAULT_SILENCE_PEAK_THRESHOLD = 0.02
DEFAULT_SILENCE_ACTIVE_FRAME_THRESHOLD = 0.012
DEFAULT_SILENCE_ACTIVE_FRAME_RATIO = 0.003
DEFAULT_SILENCE_SPEECH_FRAME_RMS_THRESHOLD = 0.006
DEFAULT_SILENCE_SPEECH_FRAME_RATIO = 0.02
DEFAULT_SILENCE_MIN_ZERO_CROSSING_RATE = 0.005
DEFAULT_SILENCE_MAX_ZERO_CROSSING_RATE = 0.35
DEFAULT_SILENCE_SPEECH_SNR_RATIO = 1.65
DEFAULT_SILENCE_SPEECH_SNR_MARGIN = 0.002
DEFAULT_SILENCE_MIN_DYNAMIC_RANGE_RATIO = 1.25
DEFAULT_SILENCE_STEADY_ACTIVE_FRAME_RATIO = 0.8
DEFAULT_SILENCE_STEADY_MAX_RMS_VARIATION = 0.08
DEFAULT_WHISPER_CPP_MIN_CONFIDENCE = 0.55
DEFAULT_WHISPER_CPP_STRONG_SPEECH_FRAME_RATIO = 0.08
DEFAULT_WHISPER_CPP_STRONG_SPEECH_RMS = 0.008


@dataclass
class AcousticStats:
    """WAV 구간이 실제 발화처럼 보이는지 판단하기 위한 가벼운 음향 지표."""

    duration: float
    rms: float
    peak: float
    active_frame_ratio: float
    speech_like_frame_ratio: float
    noise_floor_rms: float
    dynamic_range_ratio: float
    rms_variation: float


def transcribe_audio_with_whisper_cpp(args: argparse.Namespace, emit_progress: ProgressEmitter) -> dict[str, Any]:
    """whisper.cpp CLI를 실행하고 WhisperX와 호환되는 segment dict를 반환한다."""

    binary_path = Path(str(getattr(args, "whisper_cpp_binary", "") or "")).expanduser()
    model_path = Path(str(getattr(args, "whisper_cpp_model", "") or "")).expanduser()

    if not binary_path.is_file():
        raise RuntimeError(
            "whisper.cpp 실행 파일을 찾을 수 없습니다. "
            "설정에서 WhisperX를 사용하거나 MEETING_RECORDER_WHISPER_CPP_BINARY를 지정하세요."
        )

    if os.name != "nt" and not os.access(binary_path, os.X_OK):
        raise RuntimeError(f"whisper.cpp 실행 파일에 실행 권한이 없습니다: {binary_path}")

    if not model_path.is_file():
        raise RuntimeError(
            "whisper.cpp full precision large-v3 모델을 찾을 수 없습니다. "
            "MEETING_RECORDER_WHISPER_CPP_MODEL 또는 engines/models/whisper.cpp/ggml-large-v3.bin을 준비하세요."
        )

    emit_progress("model", 12, "whisper.cpp 모델 준비 완료")
    audio_path = Path(args.audio)
    emit_progress("audio", 20, "오디오를 분석하는 중")

    if should_skip_non_speech_audio(audio_path, args):
        emit_progress("transcribe", 60, "발화가 없어 whisper.cpp 전사를 건너뜀")
        return {
            "segments": [],
            "language": getattr(args, "language", None),
            "_engineName": "whisper.cpp-local-silence-gate",
        }

    with tempfile.TemporaryDirectory(prefix="meeting-recorder-whisper-cpp-") as temp_dir:
        output_prefix = str(Path(temp_dir) / "transcript")
        command, uses_dtw = build_command(binary_path, model_path, audio_path, output_prefix, args)
        emit_progress("transcribe", 25, "whisper.cpp로 음성을 텍스트로 변환하는 중")
        output = run_whisper_cpp(command)
        result_data = load_json_output(Path(temp_dir), output_prefix, output.stdout)
        segments = parse_whisper_cpp_segments(result_data, audio_path, args)

    emit_progress("transcribe", 60, "텍스트 변환 완료")
    return {
        "segments": segments,
        "language": get_result_language(result_data) or getattr(args, "language", None),
        "_engineName": "whisper.cpp-local-dtw" if uses_dtw else "whisper.cpp-local",
    }


def build_command(
    binary_path: Path,
    model_path: Path,
    audio_path: Path,
    output_prefix: str,
    args: argparse.Namespace,
) -> tuple[list[str], bool]:
    """정확도와 토큰 타임스탬프 보존을 우선하는 whisper.cpp 명령을 만든다."""

    use_context = is_contextual_decoder(args)
    final_beam_size = max(1, int(getattr(args, "final_beam_size", 5) or 5))
    best_of = max(5, final_beam_size)
    dtw_preset = resolve_dtw_preset(args, model_path)
    command = [
        str(binary_path),
        "-m",
        str(model_path),
        "-f",
        str(audio_path),
        "-l",
        str(getattr(args, "language", "ko") or "ko"),
        "-oj",
        "-ojf",
        "--print-confidence",
        "-ls",
        "-sns",
        "-sow",
        "-bs",
        str(final_beam_size),
        "-bo",
        str(best_of),
        "-tp",
        "0.0",
        "-nth",
        str(float(getattr(args, "no_speech_threshold", 0.5) or 0.5)),
        "-lpt",
        str(float(getattr(args, "log_prob_threshold", -0.9) or -0.9)),
        "-of",
        output_prefix,
        "--no-prints",
    ]

    if getattr(args, "task", "transcribe") == "translate":
        command.append("-tr")

    threads = getattr(args, "threads", None)
    if threads:
        command.extend(["-t", str(int(threads))])

    if str(getattr(args, "device", "cpu") or "cpu").lower() == "cpu":
        command.append("-ng")

    if use_context:
        prompt = get_initial_prompt(args)
        if prompt:
            command.extend(["--prompt", prompt, "--carry-initial-prompt"])
    else:
        command.extend(["-nf", "-mc", "0"])

    if dtw_preset:
        command.extend(["-nfa", "-dtw", dtw_preset])

    return command, dtw_preset is not None


def resolve_dtw_preset(args: argparse.Namespace, model_path: Path) -> str | None:
    """whisper.cpp가 지원하는 내장 alignment head preset을 고른다."""

    explicit_preset = str(getattr(args, "whisper_cpp_dtw_preset", "") or "").strip()

    if explicit_preset:
        return explicit_preset

    normalized_name = model_path.name.lower().replace("_", "-")
    preset_by_name = {
        "large-v3-turbo": "large.v3.turbo",
        "large-v3": "large.v3",
        "large-v2": "large.v2",
        "large-v1": "large.v1",
        "large": "large.v3",
        "medium.en": "medium.en",
        "medium": "medium",
        "small.en": "small.en",
        "small": "small",
        "base.en": "base.en",
        "base": "base",
        "tiny.en": "tiny.en",
        "tiny": "tiny",
    }

    for marker, preset in preset_by_name.items():
        if marker in normalized_name:
            return preset

    return None


def run_whisper_cpp(command: list[str]) -> subprocess.CompletedProcess[bytes]:
    """CLI 옵션 호환성을 위해 --no-prints가 실패하면 한 번만 제거하고 재시도한다."""

    output = subprocess.run(command, capture_output=True, text=False, check=False)

    if output.returncode == 0:
        return output

    if "--no-prints" in command:
        retry_command = [item for item in command if item != "--no-prints"]
        retry_output = subprocess.run(retry_command, capture_output=True, text=False, check=False)

        if retry_output.returncode == 0:
            return retry_output

        output = retry_output

    stderr = decode_process_output(output.stderr).strip() or decode_process_output(output.stdout).strip()
    raise RuntimeError(stderr or f"whisper.cpp 실행에 실패했습니다. 코드: {output.returncode}")


def load_json_output(temp_dir: Path, output_prefix: str, stdout: bytes) -> dict[str, Any]:
    """whisper.cpp가 파일 또는 stdout에 남긴 JSON 결과를 읽는다."""

    candidate_paths = [
        Path(f"{output_prefix}.json"),
        *sorted(temp_dir.glob("*.json")),
    ]

    for candidate_path in candidate_paths:
        if candidate_path.is_file():
            return json.loads(decode_process_output(candidate_path.read_bytes()))

    stdout_text = decode_process_output(stdout).strip()
    if stdout_text.startswith("{") and stdout_text.endswith("}"):
        return json.loads(stdout_text)

    raise RuntimeError("whisper.cpp JSON 결과를 찾지 못했습니다.")


def decode_process_output(value: bytes) -> str:
    """외부 whisper.cpp 출력이 로케일/깨진 바이트를 섞어도 전사 흐름을 중단하지 않게 디코딩한다."""

    for encoding in ("utf-8-sig", "utf-8", "cp949", "euc-kr"):
        try:
            return value.decode(encoding)
        except UnicodeDecodeError:
            continue

    return value.decode("utf-8", errors="replace")


def parse_whisper_cpp_segments(
    data: dict[str, Any],
    audio_path: Path | None = None,
    args: argparse.Namespace | None = None,
) -> list[dict[str, Any]]:
    """whisper.cpp JSON을 WhisperX segment 구조에 맞춘다."""

    raw_segments = data.get("segments")

    if not isinstance(raw_segments, list):
        raw_segments = data.get("transcription")

    if not isinstance(raw_segments, list):
        return []

    segments: list[dict[str, Any]] = []

    for raw_segment in raw_segments:
        if not isinstance(raw_segment, dict):
            continue

        start, end = get_segment_times(raw_segment)
        text = str(raw_segment.get("text") or "").strip()
        words = parse_words(raw_segment)

        if not text:
            text = "".join(str(word.get("word") or "") for word in words).strip()

        if not text:
            continue

        score = get_segment_score(raw_segment, words)
        if should_drop_unheard_segment(audio_path, start, end, score, args):
            continue

        segments.append(
            {
                "text": text,
                "start": start,
                "end": max(start, end),
                "score": score,
                "words": words,
            }
        )

    return segments


def get_segment_times(segment: dict[str, Any]) -> tuple[float, float]:
    """버전별 timestamp 필드 차이를 흡수해 초 단위 시작/종료를 구한다."""

    if "start" in segment or "end" in segment:
        return parse_timestamp(segment.get("start")), parse_timestamp(segment.get("end"))

    if "t0" in segment or "t1" in segment:
        return parse_offset(segment.get("t0")), parse_offset(segment.get("t1"))

    timestamps = segment.get("timestamps")
    if isinstance(timestamps, dict):
        return parse_timestamp(timestamps.get("from")), parse_timestamp(timestamps.get("to"))

    offsets = segment.get("offsets")
    if isinstance(offsets, dict):
        return parse_offset(offsets.get("from")), parse_offset(offsets.get("to"))

    return 0.0, 0.0


def parse_words(segment: dict[str, Any]) -> list[dict[str, Any]]:
    """word timestamp가 있으면 후처리에서 쓸 수 있는 형태로 보존한다."""

    raw_words = segment.get("words")

    if not isinstance(raw_words, list):
        raw_words = segment.get("tokens")

    if not isinstance(raw_words, list):
        return []

    words: list[dict[str, Any]] = []
    for raw_word in raw_words:
        if not isinstance(raw_word, dict):
            continue

        word_text = normalize_token_text(raw_word)
        if not word_text or is_special_token(word_text):
            continue

        start, end = get_segment_times(raw_word)
        if end <= start:
            continue

        words.append(
            {
                "start": start,
                "end": max(start, end),
                "word": word_text,
                "score": get_segment_score(raw_word),
            }
        )

    return words


def normalize_token_text(token: dict[str, Any]) -> str:
    """word/token JSON 출력의 텍스트 필드 차이를 흡수한다."""

    return str(
        token.get("word")
        or token.get("text")
        or token.get("token")
        or token.get("value")
        or ""
    )


def is_special_token(text: str) -> bool:
    """언어/타임스탬프 같은 Whisper 제어 토큰은 전사 단어에서 제외한다."""

    normalized_text = text.strip()
    return not normalized_text or SPECIAL_TOKEN_PATTERN.match(normalized_text) is not None


def should_skip_non_speech_audio(audio_path: Path, args: argparse.Namespace | None) -> bool:
    """whisper.cpp가 무음/비발화 구간에 텍스트를 붙이지 않도록 모델 호출 전 차단한다."""

    if os.environ.get("MEETING_RECORDER_STT_SILENCE_GATE") == "0":
        return False

    stats = analyze_wav_acoustics(audio_path)

    if not stats or stats.duration < 0.1:
        return False

    return is_non_speech_acoustic_stats(stats, args)


def should_drop_unheard_segment(
    audio_path: Path | None,
    start: float,
    end: float,
    score: float,
    args: argparse.Namespace | None,
) -> bool:
    """발화처럼 보이지 않는 오디오에서 나온 whisper.cpp 텍스트를 버린다."""

    if not audio_path:
        return False

    stats = analyze_wav_acoustics(audio_path, start, max(start, end))

    if not stats or stats.duration < 0.1:
        return False

    if is_non_speech_acoustic_stats(stats, args):
        return True

    min_confidence = get_float_setting("MEETING_RECORDER_WHISPER_CPP_MIN_CONFIDENCE", DEFAULT_WHISPER_CPP_MIN_CONFIDENCE)
    if score <= 0 and not is_strong_speech_acoustic_stats(stats):
        return True

    if 0 < score < min_confidence and not is_strong_speech_acoustic_stats(stats):
        return True

    return False


def is_non_speech_acoustic_stats(stats: AcousticStats, args: argparse.Namespace | None) -> bool:
    """낮은 에너지 또는 발화형 프레임 부족이면 비발화로 본다."""

    has_low_energy = (
        stats.rms <= get_float_setting("MEETING_RECORDER_STT_SILENCE_RMS_THRESHOLD", DEFAULT_SILENCE_RMS_THRESHOLD)
        and stats.peak <= get_float_setting("MEETING_RECORDER_STT_SILENCE_PEAK_THRESHOLD", DEFAULT_SILENCE_PEAK_THRESHOLD)
        and stats.active_frame_ratio
        <= get_float_setting("MEETING_RECORDER_STT_SILENCE_ACTIVE_FRAME_RATIO", DEFAULT_SILENCE_ACTIVE_FRAME_RATIO)
    )
    has_almost_no_speech_frames = stats.speech_like_frame_ratio <= get_float_setting(
        "MEETING_RECORDER_STT_SILENCE_SPEECH_FRAME_RATIO",
        DEFAULT_SILENCE_SPEECH_FRAME_RATIO,
    )
    has_flat_noise_profile = stats.dynamic_range_ratio <= get_float_setting(
        "MEETING_RECORDER_STT_SILENCE_MIN_DYNAMIC_RANGE_RATIO",
        DEFAULT_SILENCE_MIN_DYNAMIC_RANGE_RATIO,
    ) and stats.speech_like_frame_ratio <= max(
        get_float_setting("MEETING_RECORDER_STT_SILENCE_SPEECH_FRAME_RATIO", DEFAULT_SILENCE_SPEECH_FRAME_RATIO) * 2,
        0.04,
    )
    has_steady_non_speech_energy = (
        stats.active_frame_ratio
        >= get_float_setting(
            "MEETING_RECORDER_STT_SILENCE_STEADY_ACTIVE_FRAME_RATIO",
            DEFAULT_SILENCE_STEADY_ACTIVE_FRAME_RATIO,
        )
        and stats.rms_variation
        <= get_float_setting(
            "MEETING_RECORDER_STT_SILENCE_STEADY_MAX_RMS_VARIATION",
            DEFAULT_SILENCE_STEADY_MAX_RMS_VARIATION,
        )
        and has_flat_noise_profile
    )

    return has_low_energy or has_almost_no_speech_frames or has_steady_non_speech_energy


def is_strong_speech_acoustic_stats(stats: AcousticStats) -> bool:
    """저신뢰 텍스트라도 실제 발화 에너지가 충분하면 보존한다."""

    strong_speech_rms = max(
        get_float_setting("MEETING_RECORDER_WHISPER_CPP_STRONG_SPEECH_RMS", DEFAULT_WHISPER_CPP_STRONG_SPEECH_RMS),
        stats.noise_floor_rms
        * get_float_setting("MEETING_RECORDER_STT_SILENCE_SPEECH_SNR_RATIO", DEFAULT_SILENCE_SPEECH_SNR_RATIO),
        stats.noise_floor_rms
        + get_float_setting("MEETING_RECORDER_STT_SILENCE_SPEECH_SNR_MARGIN", DEFAULT_SILENCE_SPEECH_SNR_MARGIN),
    )

    return (
        stats.rms >= strong_speech_rms
        and stats.speech_like_frame_ratio
        >= get_float_setting(
            "MEETING_RECORDER_WHISPER_CPP_STRONG_SPEECH_FRAME_RATIO",
            DEFAULT_WHISPER_CPP_STRONG_SPEECH_FRAME_RATIO,
        )
    )


def analyze_wav_acoustics(audio_path: Path, start: float = 0.0, end: float | None = None) -> AcousticStats | None:
    """WAV PCM을 스트리밍으로 훑어 발화형 프레임 비율을 계산한다."""

    try:
        with wave.open(str(audio_path), "rb") as audio_file:
            sample_rate = audio_file.getframerate()
            sample_width = audio_file.getsampwidth()
            channels = max(1, audio_file.getnchannels())
            total_frames = audio_file.getnframes()

            if sample_rate <= 0 or total_frames <= 0 or sample_width not in {1, 2, 3, 4}:
                return None

            start_frame = max(0, min(total_frames, int(start * sample_rate)))
            requested_end = end if end is not None else total_frames / sample_rate
            end_frame = max(start_frame, min(total_frames, int(max(start, requested_end) * sample_rate)))

            if end_frame <= start_frame:
                return AcousticStats(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)

            audio_file.setpos(start_frame)
            return collect_acoustic_stats(audio_file, sample_rate, sample_width, channels, end_frame - start_frame)
    except (OSError, EOFError, wave.Error):
        return None


def collect_acoustic_stats(
    audio_file: wave.Wave_read,
    sample_rate: int,
    sample_width: int,
    channels: int,
    remaining_frames: int,
) -> AcousticStats:
    """프레임 RMS, peak, zero-crossing 기반 speech-like frame 비율을 계산한다."""

    frame_sample_count = max(channels, round((sample_rate * ACOUSTIC_FRAME_MS) / 1000) * channels)
    active_frame_threshold = get_float_setting(
        "MEETING_RECORDER_STT_SILENCE_ACTIVE_FRAME_THRESHOLD",
        DEFAULT_SILENCE_ACTIVE_FRAME_THRESHOLD,
    )
    speech_frame_rms_threshold = get_float_setting(
        "MEETING_RECORDER_STT_SILENCE_SPEECH_FRAME_RMS_THRESHOLD",
        DEFAULT_SILENCE_SPEECH_FRAME_RMS_THRESHOLD,
    )
    min_zero_crossing_rate = get_float_setting(
        "MEETING_RECORDER_STT_SILENCE_MIN_ZERO_CROSSING_RATE",
        DEFAULT_SILENCE_MIN_ZERO_CROSSING_RATE,
    )
    max_zero_crossing_rate = get_float_setting(
        "MEETING_RECORDER_STT_SILENCE_MAX_ZERO_CROSSING_RATE",
        DEFAULT_SILENCE_MAX_ZERO_CROSSING_RATE,
    )
    speech_snr_ratio = get_float_setting(
        "MEETING_RECORDER_STT_SILENCE_SPEECH_SNR_RATIO",
        DEFAULT_SILENCE_SPEECH_SNR_RATIO,
    )
    speech_snr_margin = get_float_setting(
        "MEETING_RECORDER_STT_SILENCE_SPEECH_SNR_MARGIN",
        DEFAULT_SILENCE_SPEECH_SNR_MARGIN,
    )
    squared_sum = 0.0
    sample_count = 0
    peak = 0.0
    frame_squared_sum = 0.0
    frame_peak = 0.0
    frame_crossings = 0
    frame_previous_sample: float | None = None
    frame_sample_cursor = 0
    frame_rms_sum = 0.0
    frame_rms_squared_sum = 0.0
    frame_stats: list[tuple[float, float, float]] = []

    def finish_frame() -> None:
        nonlocal frame_squared_sum
        nonlocal frame_peak
        nonlocal frame_crossings
        nonlocal frame_previous_sample
        nonlocal frame_sample_cursor
        nonlocal frame_rms_sum
        nonlocal frame_rms_squared_sum

        if frame_sample_cursor <= 0:
            return

        frame_rms = (frame_squared_sum / frame_sample_cursor) ** 0.5
        frame_rms_sum += frame_rms
        frame_rms_squared_sum += frame_rms * frame_rms
        zero_crossing_rate = frame_crossings / max(1, frame_sample_cursor - 1)
        frame_stats.append((frame_rms, frame_peak, zero_crossing_rate))

        frame_squared_sum = 0.0
        frame_peak = 0.0
        frame_crossings = 0
        frame_previous_sample = None
        frame_sample_cursor = 0

    frames_left = remaining_frames
    read_chunk_frames = max(1, sample_rate)

    while frames_left > 0:
        frames = audio_file.readframes(min(read_chunk_frames, frames_left))
        frames_read = len(frames) // max(1, sample_width * channels)

        if frames_read <= 0:
            break

        frames_left -= frames_read

        for sample in iter_pcm_samples(frames, sample_width):
            magnitude = abs(sample)
            squared_sum += sample * sample
            sample_count += 1
            peak = max(peak, magnitude)
            frame_squared_sum += sample * sample
            frame_peak = max(frame_peak, magnitude)

            if (
                frame_previous_sample is not None
                and abs(frame_previous_sample) > 0.001
                and magnitude > 0.001
                and (frame_previous_sample < 0 < sample or frame_previous_sample > 0 > sample)
            ):
                frame_crossings += 1

            frame_previous_sample = sample
            frame_sample_cursor += 1

            if frame_sample_cursor >= frame_sample_count:
                finish_frame()

    finish_frame()

    if sample_count <= 0:
        return AcousticStats(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)

    total_frames = len(frame_stats)
    frame_rms_values = [frame_rms for frame_rms, _frame_peak, _zero_crossing_rate in frame_stats]
    noise_floor_rms = percentile(frame_rms_values, 0.2)
    high_frame_rms = percentile(frame_rms_values, 0.9)
    speech_frame_threshold = max(
        speech_frame_rms_threshold,
        noise_floor_rms * speech_snr_ratio,
        noise_floor_rms + speech_snr_margin,
    )
    active_frames = sum(1 for _frame_rms, frame_peak, _zero_crossing_rate in frame_stats if frame_peak >= active_frame_threshold)
    speech_like_frames = sum(
        1
        for frame_rms, _frame_peak, zero_crossing_rate in frame_stats
        if frame_rms >= speech_frame_threshold and min_zero_crossing_rate <= zero_crossing_rate <= max_zero_crossing_rate
    )
    average_frame_rms = frame_rms_sum / total_frames if total_frames > 0 else 0.0
    frame_rms_variance = max(0.0, frame_rms_squared_sum / total_frames - average_frame_rms * average_frame_rms) if total_frames > 0 else 0.0

    return AcousticStats(
        duration=sample_count / max(1, sample_rate * channels),
        rms=(squared_sum / sample_count) ** 0.5,
        peak=peak,
        active_frame_ratio=active_frames / total_frames if total_frames > 0 else 0.0,
        speech_like_frame_ratio=speech_like_frames / total_frames if total_frames > 0 else 0.0,
        noise_floor_rms=noise_floor_rms,
        dynamic_range_ratio=high_frame_rms / max(noise_floor_rms, 1e-9),
        rms_variation=(frame_rms_variance**0.5) / max(average_frame_rms, 1e-9),
    )


def percentile(values: list[float], ratio: float) -> float:
    """프레임 RMS 분포에서 간단한 분위수를 구한다."""

    if not values:
        return 0.0

    sorted_values = sorted(values)
    index = min(len(sorted_values) - 1, int((len(sorted_values) - 1) * max(0.0, min(1.0, ratio))))
    return sorted_values[index]


def iter_pcm_samples(frames: bytes, sample_width: int):
    """PCM byte 배열을 -1..1 float sample로 변환해 순회한다."""

    if sample_width == 1:
        for sample in frames:
            yield (sample - 128) / 128
        return

    sample_count = len(frames) // sample_width
    if sample_width == 2:
        for (sample,) in struct.iter_unpack("<h", frames[: sample_count * sample_width]):
            yield sample / 32768
        return

    if sample_width == 3:
        for offset in range(0, sample_count * sample_width, sample_width):
            yield int.from_bytes(frames[offset : offset + sample_width], "little", signed=True) / 8388608
        return

    for (sample,) in struct.iter_unpack("<i", frames[: sample_count * sample_width]):
        yield sample / 2147483648


def get_float_setting(name: str, default_value: float) -> float:
    """환경변수 기반 음향 게이트 값을 안전하게 읽는다."""

    raw_value = os.environ.get(name)

    if raw_value is None:
        return default_value

    try:
        value = float(raw_value)
    except ValueError:
        return default_value

    return value


def parse_timestamp(value: Any) -> float:
    """숫자 또는 HH:MM:SS.mmm 문자열을 초 단위로 바꾼다."""

    if isinstance(value, (int, float)):
        return float(value)

    if not isinstance(value, str):
        return 0.0

    match = TIMESTAMP_PATTERN.search(value)
    if not match:
        return 0.0

    hours = int(match.group(1) or 0)
    minutes = int(match.group(2) or 0)
    seconds = int(match.group(3) or 0)
    fraction_text = (match.group(4) or "").ljust(3, "0")[:3]
    milliseconds = int(fraction_text or 0)
    return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000


def parse_offset(value: Any) -> float:
    """whisper.cpp offset 값은 주로 밀리초이므로 큰 숫자는 초로 환산한다."""

    if not isinstance(value, (int, float)):
        return parse_timestamp(value)

    numeric_value = float(value)
    return numeric_value / 1000 if numeric_value > 1000 else numeric_value


def get_segment_score(segment: dict[str, Any], words: list[dict[str, Any]] | None = None) -> float:
    """가능한 confidence 계열 값을 사용하고 없으면 0으로 둔다."""

    for key in ("score", "confidence", "probability", "prob", "p"):
        value = segment.get(key)

        if isinstance(value, (int, float)):
            return round(float(value), 4)

    if words:
        scores = [float(word["score"]) for word in words if isinstance(word.get("score"), (int, float))]

        if scores:
            return round(sum(scores) / len(scores), 4)

    return 0.0


def get_result_language(data: dict[str, Any]) -> str | None:
    """whisper.cpp JSON 버전별 language 위치를 정규화한다."""

    language = data.get("language")
    if isinstance(language, str) and language:
        return language

    result = data.get("result")
    if isinstance(result, dict):
        language = result.get("language")
        if isinstance(language, str) and language:
            return language

    return None
