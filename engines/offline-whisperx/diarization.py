"""sherpa-onnx 기반 화자분리와 화자 라벨 유틸리티를 제공한다."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SPEAKER_COLORS = ["#1f7a8c", "#b45f06", "#4f6f52", "#6d597a", "#607d8b", "#8a5a44"]


@dataclass(frozen=True)
class DiarizedTurn:
    """sherpa-onnx가 반환한 화자 발화 구간을 앱에서 쓰기 쉬운 형태로 보관한다."""

    start: float
    end: float
    speaker_label: str


@dataclass(frozen=True)
class OverlapRegion:
    """서로 다른 두 화자의 발화 시간이 겹친 구간을 표현한다."""

    start: float
    end: float
    group_id: str


def diarize_audio(audio: Any, args: argparse.Namespace) -> list[DiarizedTurn]:
    """sherpa-onnx 로컬 ONNX 모델로 화자 발화 구간을 추출한다."""

    try:
        import sherpa_onnx  # type: ignore
    except ImportError as error:
        raise RuntimeError(
            "standalone 화자분리 엔진 의존성이 없습니다. "
            "`npm run setup:stt`를 실행해 sherpa-onnx를 설치하세요."
        ) from error

    segmentation_model, embedding_model = resolve_diarization_model_paths(args)
    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                model=str(segmentation_model),
            ),
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(embedding_model)),
        clustering=sherpa_onnx.FastClusteringConfig(
            num_clusters=resolve_num_clusters(args),
            threshold=args.cluster_threshold,
        ),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )

    if not config.validate():
        raise RuntimeError("앱에 포함된 화자분리 모델 파일을 확인할 수 없습니다.")

    diarizer = sherpa_onnx.OfflineSpeakerDiarization(config)
    result = diarizer.process(audio).sort_by_start_time()
    return [
        DiarizedTurn(
            start=float(segment.start),
            end=float(segment.end),
            speaker_label=f"SPEAKER_{int(segment.speaker):02d}",
        )
        for segment in result
    ]


def resolve_num_clusters(args: argparse.Namespace) -> int:
    """알고 있는 화자 수가 있으면 sherpa-onnx 클러스터 수로 변환한다."""

    if args.num_speakers > 0:
        return args.num_speakers

    if args.min_speakers and args.max_speakers and args.min_speakers == args.max_speakers:
        return args.min_speakers

    return -1


def resolve_diarization_model_paths(args: argparse.Namespace) -> tuple[Path, Path]:
    """standalone 패키지에 포함된 sherpa-onnx 모델 파일 경로를 계산한다."""

    asset_root = Path(args.asset_root or Path(__file__).resolve().parents[1] / "models")
    segmentation_model = Path(
        args.diarization_segmentation_model
        or asset_root / "diarization/sherpa-onnx-pyannote-segmentation-3-0/model.onnx"
    )
    embedding_model = Path(
        args.diarization_embedding_model
        or asset_root / "diarization/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
    )
    missing_paths = [str(model_path) for model_path in (segmentation_model, embedding_model) if not model_path.is_file()]

    if missing_paths:
        raise RuntimeError(
            "standalone 화자분리 모델이 앱에 포함되어 있지 않습니다. "
            "릴리즈 빌드 전에 `npm run setup:engine-assets`를 실행하세요. "
            f"누락: {', '.join(missing_paths)}"
        )

    return segmentation_model, embedding_model


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
    """화자 라벨을 앱의 speakerId와 표시 이름으로 변환한다."""

    labels = sorted({turn.speaker_label for turn in turns}) or ["SPEAKER_00"]
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


def get_speaker_label(start: float, end: float, turns: list[DiarizedTurn]) -> str:
    """전사 구간과 가장 많이 겹치는 화자 라벨을 찾는다."""

    best_label = turns[0].speaker_label if turns else "SPEAKER_00"
    best_overlap = 0.0

    for turn in turns:
        overlap = min(end, turn.end) - max(start, turn.start)

        if overlap > best_overlap:
            best_overlap = overlap
            best_label = turn.speaker_label

    if best_overlap > 0:
        return best_label

    midpoint = (start + end) / 2
    nearest_turn = min(turns, key=lambda turn: abs(((turn.start + turn.end) / 2) - midpoint), default=None)
    return nearest_turn.speaker_label if nearest_turn else best_label
