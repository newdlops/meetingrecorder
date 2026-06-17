"""sherpa-onnx 기반 화자분리와 화자 라벨 유틸리티를 제공한다."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SPEAKER_COLORS = ["#1f7a8c", "#b45f06", "#4f6f52", "#6d597a", "#607d8b", "#8a5a44"]
SPEAKER_NAME_PREFIX = "참석자"
_DIARIZER_CACHE: dict[tuple[str, str, int, float], Any] = {}
DEFAULT_DIARIZATION_MIN_TURN_MS = 650.0
DEFAULT_DIARIZATION_MERGE_GAP_MS = 300.0
DEFAULT_DIARIZATION_OVERLAP_MIN_TURN_MS = 180.0
DEFAULT_DIARIZATION_OVERLAP_BRIDGE_GAP_MS = 220.0
DEFAULT_DIARIZATION_OVERLAP_PADDING_MS = 160.0


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
    num_clusters = resolve_num_clusters(args)
    cache_key = (str(segmentation_model), str(embedding_model), num_clusters, float(args.cluster_threshold))
    diarizer = _DIARIZER_CACHE.get(cache_key)

    if diarizer:
        result = diarizer.process(audio).sort_by_start_time()
        return smooth_turns(build_turns(result), args)

    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                model=str(segmentation_model),
            ),
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(embedding_model)),
        clustering=sherpa_onnx.FastClusteringConfig(
            num_clusters=num_clusters,
            threshold=args.cluster_threshold,
        ),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )

    if not config.validate():
        raise RuntimeError("앱에 포함된 화자분리 모델 파일을 확인할 수 없습니다.")

    diarizer = sherpa_onnx.OfflineSpeakerDiarization(config)
    _DIARIZER_CACHE[cache_key] = diarizer
    result = diarizer.process(audio).sort_by_start_time()
    return smooth_turns(build_turns(result), args)


def build_turns(result: Any) -> list[DiarizedTurn]:
    """sherpa-onnx 결과를 앱 내부 화자 구간 목록으로 변환한다."""

    return [
        DiarizedTurn(
            start=float(segment.start),
            end=float(segment.end),
            speaker_label=f"SPEAKER_{int(segment.speaker):02d}",
        )
        for segment in result
    ]


def smooth_turns(turns: list[DiarizedTurn], args: argparse.Namespace) -> list[DiarizedTurn]:
    """짧게 튀는 화자 구간을 주변 문맥으로 보정해 단어 단위 화자 흔들림을 줄인다."""

    merge_gap = resolve_merge_gap_seconds(args)
    normalized_turns = merge_adjacent_same_speaker(
        sorted((turn for turn in turns if turn.end > turn.start), key=lambda turn: (turn.start, turn.end)),
        merge_gap,
    )
    min_duration = resolve_min_turn_seconds(args)
    overlap_min_duration = resolve_overlap_min_turn_seconds(args)

    if min_duration <= 0 or len(normalized_turns) < 3:
        return normalized_turns

    smoothed_turns: list[DiarizedTurn] = []

    for index, turn in enumerate(normalized_turns):
        previous_turn = smoothed_turns[-1] if smoothed_turns else None
        next_turn = normalized_turns[index + 1] if index + 1 < len(normalized_turns) else None
        replacement_label = choose_replacement_label(
            turn,
            previous_turn,
            next_turn,
            min_duration,
            merge_gap,
            overlap_min_duration,
        )
        next_turn = DiarizedTurn(start=turn.start, end=turn.end, speaker_label=replacement_label)

        if smoothed_turns and smoothed_turns[-1].speaker_label == next_turn.speaker_label:
            previous = smoothed_turns[-1]
            smoothed_turns[-1] = DiarizedTurn(
                start=previous.start,
                end=max(previous.end, next_turn.end),
                speaker_label=previous.speaker_label,
            )
            continue

        smoothed_turns.append(next_turn)

    return merge_adjacent_same_speaker(smoothed_turns, merge_gap)


def choose_replacement_label(
    turn: DiarizedTurn,
    previous_turn: DiarizedTurn | None,
    next_turn: DiarizedTurn | None,
    min_duration: float,
    merge_gap: float,
    overlap_min_duration: float,
) -> str:
    """짧은 구간이 앞뒤의 같은 긴 화자 사이에 끼었거나 겹쳐 있으면 주변 화자로 흡수한다."""

    duration = turn.end - turn.start

    if duration >= min_duration:
        return turn.speaker_label

    if (
        previous_turn
        and next_turn
        and previous_turn.speaker_label == next_turn.speaker_label
        and gap_between(previous_turn, turn) <= merge_gap
        and gap_between(turn, next_turn) <= merge_gap
    ):
        return previous_turn.speaker_label

    previous_overlap = overlap_seconds(previous_turn, turn) if previous_turn else 0.0
    next_overlap = overlap_seconds(next_turn, turn) if next_turn else 0.0
    overlap_floor = max(0.05, duration * 0.5)
    overlap_preserve_floor = max(0.08, duration * 0.35)

    if (
        previous_turn
        and previous_turn.speaker_label != turn.speaker_label
        and duration >= overlap_min_duration
        and previous_overlap >= overlap_preserve_floor
    ):
        return turn.speaker_label

    if (
        next_turn
        and next_turn.speaker_label != turn.speaker_label
        and duration >= overlap_min_duration
        and next_overlap >= overlap_preserve_floor
    ):
        return turn.speaker_label

    if previous_turn and previous_overlap >= overlap_floor and turn_duration(previous_turn) >= min_duration:
        return previous_turn.speaker_label

    if next_turn and next_overlap >= overlap_floor and turn_duration(next_turn) >= min_duration:
        return next_turn.speaker_label

    if duration >= min_duration * 0.5:
        return turn.speaker_label

    adjacent_candidates = [
        candidate
        for candidate in (previous_turn, next_turn)
        if candidate and turn_duration(candidate) >= min_duration and abs(gap_between(candidate, turn)) <= merge_gap
    ]

    if not adjacent_candidates:
        return turn.speaker_label

    nearest_turn = min(
        adjacent_candidates,
        key=lambda candidate: abs(((candidate.start + candidate.end) / 2) - ((turn.start + turn.end) / 2)),
    )
    return nearest_turn.speaker_label


def merge_adjacent_same_speaker(turns: list[DiarizedTurn], max_gap: float) -> list[DiarizedTurn]:
    """인접한 같은 화자 턴은 작은 공백까지 같은 발화로 합친다."""

    merged_turns: list[DiarizedTurn] = []

    for turn in turns:
        if not merged_turns:
            merged_turns.append(turn)
            continue

        previous = merged_turns[-1]

        if previous.speaker_label == turn.speaker_label and turn.start - previous.end <= max_gap:
            merged_turns[-1] = DiarizedTurn(
                start=previous.start,
                end=max(previous.end, turn.end),
                speaker_label=previous.speaker_label,
            )
            continue

        merged_turns.append(turn)

    return merged_turns


def resolve_min_turn_seconds(args: argparse.Namespace) -> float:
    """짧은 튐 보정 기준을 초 단위로 계산한다."""

    return max(0.0, float(getattr(args, "diarization_min_turn_ms", DEFAULT_DIARIZATION_MIN_TURN_MS)) / 1000)


def resolve_merge_gap_seconds(args: argparse.Namespace) -> float:
    """같은 화자 턴을 합칠 수 있는 최대 공백을 초 단위로 계산한다."""

    return max(0.0, float(getattr(args, "diarization_merge_gap_ms", DEFAULT_DIARIZATION_MERGE_GAP_MS)) / 1000)


def resolve_overlap_min_turn_seconds(args: argparse.Namespace | None) -> float:
    """동시 발화 후보로 보존할 최소 화자 턴 길이를 초 단위로 계산한다."""

    return max(
        0.0,
        float(getattr(args, "diarization_overlap_min_turn_ms", DEFAULT_DIARIZATION_OVERLAP_MIN_TURN_MS)) / 1000,
    )


def resolve_overlap_bridge_gap_seconds(args: argparse.Namespace | None) -> float:
    """겹침 대신 짧은 화자 전환으로 나온 구간을 동시 발화 후보로 묶는 최대 간격을 계산한다."""

    return max(
        0.0,
        float(getattr(args, "diarization_overlap_bridge_gap_ms", DEFAULT_DIARIZATION_OVERLAP_BRIDGE_GAP_MS)) / 1000,
    )


def resolve_overlap_padding_seconds(args: argparse.Namespace | None) -> float:
    """동시 발화 후보 경계 주변에 표시용 여유 시간을 더한다."""

    return max(
        0.0,
        float(getattr(args, "diarization_overlap_padding_ms", DEFAULT_DIARIZATION_OVERLAP_PADDING_MS)) / 1000,
    )


def turn_duration(turn: DiarizedTurn) -> float:
    """화자 턴 길이를 초 단위로 반환한다."""

    return max(0.0, turn.end - turn.start)


def overlap_seconds(left: DiarizedTurn | None, right: DiarizedTurn | None) -> float:
    """두 화자 턴이 겹치는 시간을 초 단위로 계산한다."""

    if not left or not right:
        return 0.0

    return max(0.0, min(left.end, right.end) - max(left.start, right.start))


def gap_between(left: DiarizedTurn, right: DiarizedTurn) -> float:
    """두 구간 사이의 공백을 계산한다. 겹치면 음수 값이 된다."""

    if left.start <= right.start:
        return right.start - left.end

    return left.start - right.end


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


def find_overlap_regions(turns: list[DiarizedTurn], args: argparse.Namespace | None = None) -> list[OverlapRegion]:
    """서로 다른 화자 발화가 겹치거나 거의 맞물리는 구간 목록을 만든다."""

    regions: list[OverlapRegion] = []
    sorted_turns = sorted(turns, key=lambda turn: (turn.start, turn.end))
    bridge_gap = resolve_overlap_bridge_gap_seconds(args)
    padding = resolve_overlap_padding_seconds(args)
    min_region = max(0.03, resolve_overlap_min_turn_seconds(args) * 0.5)

    for left_index, left in enumerate(sorted_turns):
        for right in sorted_turns[left_index + 1 :]:
            if right.start >= left.end:
                break

            if left.speaker_label == right.speaker_label:
                continue

            start = max(left.start, right.start)
            end = min(left.end, right.end)

            if end - start >= min_region:
                regions.append(create_overlap_region(start, end, len(regions) + 1))

    for left, right in zip(sorted_turns, sorted_turns[1:]):
        if left.speaker_label == right.speaker_label:
            continue

        gap = right.start - left.end

        if gap < 0 or gap > bridge_gap:
            continue

        start = max(left.start, left.end - padding)
        end = min(right.end, right.start + padding)

        if end - start >= min_region and not overlaps_existing_region(start, end, regions):
            regions.append(create_overlap_region(start, end, len(regions) + 1))

    return regions


def create_overlap_region(start: float, end: float, index: int) -> OverlapRegion:
    """동시 발화 표시 구간을 만든다."""

    return OverlapRegion(start=start, end=end, group_id=f"overlap-{index}")


def overlaps_existing_region(start: float, end: float, regions: list[OverlapRegion]) -> bool:
    """이미 잡힌 동시 발화 구간과 겹치는지 확인한다."""

    return any(start < region.end and end > region.start for region in regions)


def build_speakers(turns: list[DiarizedTurn]) -> tuple[list[dict[str, str]], dict[str, str]]:
    """화자 라벨을 앱의 speakerId와 표시 이름으로 변환한다."""

    labels = sorted({turn.speaker_label for turn in turns}) or ["SPEAKER_00"]
    label_to_id = {label: f"speaker-{index + 1}" for index, label in enumerate(labels)}
    speakers = [
        {
            "id": label_to_id[label],
            "name": build_speaker_name(index),
            "color": SPEAKER_COLORS[index % len(SPEAKER_COLORS)],
        }
        for index, label in enumerate(labels)
    ]
    return speakers, label_to_id


def build_speaker_name(index: int) -> str:
    """익명 화자에게 구분하기 쉬운 임의 이름을 붙인다."""

    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    value = max(0, index)
    label = ""

    while True:
        label = f"{alphabet[value % len(alphabet)]}{label}"
        value = value // len(alphabet) - 1

        if value < 0:
            break

    return f"{SPEAKER_NAME_PREFIX} {label}"


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
