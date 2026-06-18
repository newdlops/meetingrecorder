"""whisper.cpp CLI를 기존 WhisperX 결과 형태로 변환하는 어댑터."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable

ProgressEmitter = Callable[[str, int, str], None]

TIMESTAMP_PATTERN = re.compile(r"(?:(\d+):)?(\d+):(\d+)(?:[.,](\d+))?")


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
    emit_progress("audio", 20, "오디오를 분석하는 중")

    with tempfile.TemporaryDirectory(prefix="meeting-recorder-whisper-cpp-") as temp_dir:
        output_prefix = str(Path(temp_dir) / "transcript")
        command = build_command(binary_path, model_path, Path(args.audio), output_prefix, args)
        emit_progress("transcribe", 25, "whisper.cpp로 음성을 텍스트로 변환하는 중")
        output = run_whisper_cpp(command)
        result_data = load_json_output(Path(temp_dir), output_prefix, output.stdout)
        segments = parse_whisper_cpp_segments(result_data)

    emit_progress("transcribe", 60, "텍스트 변환 완료")
    return {
        "segments": segments,
        "language": result_data.get("language") or getattr(args, "language", None),
        "_engineName": "whisper.cpp-local",
    }


def build_command(
    binary_path: Path,
    model_path: Path,
    audio_path: Path,
    output_prefix: str,
    args: argparse.Namespace,
) -> list[str]:
    """현재 whisper.cpp CLI에서 널리 쓰이는 JSON 출력 인자로 명령을 만든다."""

    command = [
        str(binary_path),
        "-m",
        str(model_path),
        "-f",
        str(audio_path),
        "-l",
        str(getattr(args, "language", "ko") or "ko"),
        "-oj",
        "-of",
        output_prefix,
        "--no-prints",
    ]

    if getattr(args, "task", "transcribe") == "translate":
        command.append("-tr")

    threads = getattr(args, "threads", None)
    if threads:
        command.extend(["-t", str(int(threads))])

    return command


def run_whisper_cpp(command: list[str]) -> subprocess.CompletedProcess[str]:
    """CLI 옵션 호환성을 위해 --no-prints가 실패하면 한 번만 제거하고 재시도한다."""

    output = subprocess.run(command, capture_output=True, text=True, check=False)

    if output.returncode == 0:
        return output

    if "--no-prints" in command:
        retry_command = [item for item in command if item != "--no-prints"]
        retry_output = subprocess.run(retry_command, capture_output=True, text=True, check=False)

        if retry_output.returncode == 0:
            return retry_output

        output = retry_output

    stderr = output.stderr.strip() or output.stdout.strip()
    raise RuntimeError(stderr or f"whisper.cpp 실행에 실패했습니다. 코드: {output.returncode}")


def load_json_output(temp_dir: Path, output_prefix: str, stdout: str) -> dict[str, Any]:
    """whisper.cpp가 파일 또는 stdout에 남긴 JSON 결과를 읽는다."""

    candidate_paths = [
        Path(f"{output_prefix}.json"),
        *sorted(temp_dir.glob("*.json")),
    ]

    for candidate_path in candidate_paths:
        if candidate_path.is_file():
            with candidate_path.open("r", encoding="utf-8") as file:
                return json.load(file)

    stdout_text = stdout.strip()
    if stdout_text.startswith("{") and stdout_text.endswith("}"):
        return json.loads(stdout_text)

    raise RuntimeError("whisper.cpp JSON 결과를 찾지 못했습니다.")


def parse_whisper_cpp_segments(data: dict[str, Any]) -> list[dict[str, Any]]:
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

        if not text:
            continue

        segments.append(
            {
                "text": text,
                "start": start,
                "end": max(start, end),
                "score": get_segment_score(raw_segment),
                "words": parse_words(raw_segment),
            }
        )

    return segments


def get_segment_times(segment: dict[str, Any]) -> tuple[float, float]:
    """버전별 timestamp 필드 차이를 흡수해 초 단위 시작/종료를 구한다."""

    if "start" in segment or "end" in segment:
        return parse_timestamp(segment.get("start")), parse_timestamp(segment.get("end"))

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
        return []

    words: list[dict[str, Any]] = []
    for raw_word in raw_words:
        if not isinstance(raw_word, dict):
            continue

        word_text = str(raw_word.get("word") or raw_word.get("text") or "").strip()
        if not word_text:
            continue

        start, end = get_segment_times(raw_word)
        words.append(
            {
                "start": start,
                "end": max(start, end),
                "word": word_text,
                "score": get_segment_score(raw_word),
            }
        )

    return words


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


def get_segment_score(segment: dict[str, Any]) -> float:
    """가능한 confidence 계열 값을 사용하고 없으면 0으로 둔다."""

    for key in ("score", "confidence", "probability", "p"):
        value = segment.get(key)

        if isinstance(value, (int, float)):
            return round(float(value), 4)

    return 0.0
