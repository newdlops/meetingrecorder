#!/usr/bin/env python3
"""Whisper 모델을 한 번만 로드해 여러 전사 요청을 처리하는 상주 worker."""

from __future__ import annotations

import argparse
import gc
import json
import os
import sys
import traceback
from typing import Any

from diarization import diarize_audio
from worker import (
    DEFAULT_CLUSTER_THRESHOLD,
    DEFAULT_DIARIZATION_MERGE_GAP_MS,
    DEFAULT_DIARIZATION_MIN_TURN_MS,
    DEFAULT_LANGUAGE,
    DEFAULT_TASK,
    build_asr_options,
    build_output,
    build_transcription_only_output,
    build_vad_options,
    call_with_supported_kwargs,
    configure_offline_mode,
    import_engine_modules,
)
from quality_transcription import (
    add_quality_args,
    should_use_standard_decoder,
    transcribe_audio_with_standard_decoder,
)


def parse_args() -> argparse.Namespace:
    """Electron 메인 프로세스가 넘긴 상주 worker 초기화 옵션을 읽는다."""

    parser = argparse.ArgumentParser(description="Persistent offline WhisperX worker")
    parser.add_argument("--model", required=True, help="Whisper 모델 경로")
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
    parser.add_argument("--threads", type=int, help="CPU 추론 스레드 수")
    parser.add_argument("--no-speech-threshold", type=float, default=0.5, help="무음으로 판단할 no-speech 확률 기준")
    parser.add_argument("--log-prob-threshold", type=float, default=-0.9, help="낮은 신뢰도 전사를 버릴 로그 확률 기준")
    parser.add_argument("--hallucination-silence-threshold", type=float, default=1.0, help="무음 주변 환각 전사 제거 기준")
    parser.add_argument("--vad-onset", type=float, default=0.35, help="VAD 발화 시작 민감도")
    parser.add_argument("--vad-offset", type=float, default=0.25, help="VAD 발화 종료 민감도")
    parser.add_argument("--enable-align", action="store_true", help="외부 alignment 모델을 사용해 단어 타임스탬프를 보정")
    parser.add_argument("--offline-only", action="store_true", help="로컬 캐시 모델만 사용")
    add_quality_args(parser)
    return parser.parse_args()


def emit(message: dict[str, Any]) -> None:
    """Node 프로세스가 읽을 수 있도록 프로토콜 메시지를 한 줄 JSON으로 출력한다."""

    print(json.dumps(message, ensure_ascii=False), flush=True)


def emit_progress(request_id: str, request: dict[str, Any], stage: str, progress: int, message: str) -> None:
    """요청별 진행률 이벤트를 Node 프로세스에 전달한다."""

    if not request.get("progress"):
        return

    emit(
        {
            "type": "progress",
            "id": request_id,
            "stage": stage,
            "progress": progress,
            "message": message,
        }
    )


def release_request_memory(*values: Any) -> None:
    """요청 단위 대형 객체 참조를 끊고 상주 worker의 메모리 반환 기회를 만든다."""

    for value in values:
        if isinstance(value, dict):
            value.pop("_audio", None)
            value.clear()
        elif isinstance(value, list):
            value.clear()

    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            torch.cuda.empty_cache()

        if hasattr(torch, "mps") and hasattr(torch.mps, "empty_cache"):
            torch.mps.empty_cache()
    except Exception:
        pass

    gc.collect()


def load_cached_model(whisperx: Any, args: argparse.Namespace) -> Any:
    """상주 worker 시작 시 Whisper 모델을 메모리에 한 번만 로드한다."""

    return call_with_supported_kwargs(
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


def build_request_args(base_args: argparse.Namespace, request: dict[str, Any]) -> argparse.Namespace:
    """요청 JSON과 초기 옵션을 합쳐 기존 전사/화자분리 함수가 쓰는 Namespace를 만든다."""

    next_args = argparse.Namespace(**vars(base_args))
    next_args.audio = str(request["audioPath"])
    next_args.batch_size = int(request.get("batchSize") or 4)
    next_args.min_speakers = request.get("minSpeakers")
    next_args.max_speakers = request.get("maxSpeakers")
    next_args.transcribe_only = bool(request.get("transcribeOnly"))
    next_args.progress = False
    return next_args


def transcribe_with_cached_model(
    whisperx: Any,
    model: Any,
    args: argparse.Namespace,
    request_id: str,
    request: dict[str, Any],
) -> dict[str, Any]:
    """이미 로드된 Whisper 모델로 한 요청의 오디오를 전사한다."""

    emit_progress(request_id, request, "model", 12, "전사 모델 준비 완료")
    emit_progress(request_id, request, "audio", 20, "오디오를 분석하는 중")
    audio = whisperx.load_audio(args.audio)
    emit_progress(request_id, request, "transcribe", 25, "음성을 텍스트로 변환하는 중")
    result = call_with_supported_kwargs(
        model.transcribe,
        audio,
        batch_size=args.batch_size,
        language=args.language,
        task=args.task,
    )
    emit_progress(request_id, request, "transcribe", 60, "텍스트 변환 완료")
    result["_audio"] = audio
    return result


def process_request(whisperx: Any, model: Any, base_args: argparse.Namespace, request: dict[str, Any]) -> None:
    """stdin으로 받은 단일 전사 요청을 처리하고 result/error 메시지를 보낸다."""

    request_id = str(request["id"])
    audio: Any | None = None
    result: dict[str, Any] | None = None
    output: dict[str, Any] | None = None
    turns: list[Any] | None = None

    try:
        request_args = build_request_args(base_args, request)
        if should_use_standard_decoder(request_args):
            emit_progress(request_id, request, "model", 12, "전사 모델 준비 완료")
            emit_progress(request_id, request, "audio", 20, "오디오를 분석하는 중")
            audio = whisperx.load_audio(request_args.audio)
            result = transcribe_audio_with_standard_decoder(
                model,
                audio,
                request_args,
                lambda stage, progress, message: emit_progress(request_id, request, stage, progress, message),
            )
        else:
            result = transcribe_with_cached_model(whisperx, model, request_args, request_id, request)

        if request_args.transcribe_only:
            output = build_transcription_only_output(result)
            emit({"type": "result", "id": request_id, "result": output})
            return

        emit_progress(request_id, request, "align", 68, "단어 시간 보정을 건너뜀")
        emit_progress(request_id, request, "diarize", 72, "화자를 분리하는 중")
        turns = diarize_audio(result["_audio"], request_args)
        emit_progress(request_id, request, "diarize", 90, "화자 분리 완료")
        emit_progress(request_id, request, "save", 96, "전사 결과를 정리하는 중")
        output = build_output(result, turns)
        emit({"type": "result", "id": request_id, "result": output})
    except Exception as error:
        emit({"type": "error", "id": request_id, "message": str(error)})

        if os.environ.get("MEETING_RECORDER_STT_DEBUG") == "1":
            traceback.print_exc(file=sys.stderr)
    finally:
        audio = None
        release_request_memory(output, result, turns)


def main() -> int:
    """모델을 메모리에 올린 뒤 stdin JSON 요청을 계속 처리한다."""

    args = parse_args()
    configure_offline_mode(args.offline_only)

    try:
        whisperx = import_engine_modules()
        model = load_cached_model(whisperx, args)
        emit({"type": "ready"})

        for line in sys.stdin:
            if not line.strip():
                continue

            request = json.loads(line)

            if request.get("type") == "shutdown":
                return 0

            if request.get("type") == "transcribe":
                process_request(whisperx, model, args, request)
    except Exception as error:
        print(str(error), file=sys.stderr)

        if os.environ.get("MEETING_RECORDER_STT_DEBUG") == "1":
            traceback.print_exc(file=sys.stderr)

        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
