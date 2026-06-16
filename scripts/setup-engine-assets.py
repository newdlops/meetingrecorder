#!/usr/bin/env python3
"""standalone 배포에 포함할 오프라인 STT/화자분리 모델 자산을 준비한다."""

from __future__ import annotations

import argparse
import bz2
import shutil
import tarfile
import urllib.request
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ASSET_ROOT = REPO_ROOT / "engines" / "models"
SEGMENTATION_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/"
    "sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
)
EMBEDDING_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/"
    "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
)
WHISPER_REPO_ID = "Systran/faster-whisper-large-v3"


def parse_args() -> argparse.Namespace:
    """모델 저장 위치와 Whisper 모델 ID를 CLI 인자로 받는다."""

    parser = argparse.ArgumentParser(description="Prepare bundled offline engine models")
    parser.add_argument("--asset-root", default=str(DEFAULT_ASSET_ROOT), help="모델을 저장할 앱 자산 루트")
    parser.add_argument("--whisper-repo-id", default=WHISPER_REPO_ID, help="faster-whisper CTranslate2 모델 repo")
    return parser.parse_args()


def download_file(url: str, target_path: Path) -> None:
    """URL에서 파일을 내려받아 대상 경로에 저장한다."""

    target_path.parent.mkdir(parents=True, exist_ok=True)

    if target_path.is_file():
        print(f"skip {target_path}")
        return

    print(f"download {url}")
    urllib.request.urlretrieve(url, target_path)


def prepare_sherpa_diarization(asset_root: Path) -> None:
    """sherpa-onnx 화자분리 모델 두 개를 로컬 자산 폴더에 준비한다."""

    diarization_root = asset_root / "diarization"
    archive_path = diarization_root / "sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
    segmentation_dir = diarization_root / "sherpa-onnx-pyannote-segmentation-3-0"
    embedding_path = diarization_root / "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"

    download_file(SEGMENTATION_URL, archive_path)
    download_file(EMBEDDING_URL, embedding_path)

    if not (segmentation_dir / "model.onnx").is_file():
        print(f"extract {archive_path}")
        with bz2.open(archive_path, "rb") as compressed_file:
            with tarfile.open(fileobj=compressed_file, mode="r:") as tar:
                tar.extractall(diarization_root)


def prepare_whisper_model(asset_root: Path, repo_id: str) -> None:
    """faster-whisper 모델을 앱 자산 폴더에 snapshot 형태로 내려받는다."""

    try:
        from huggingface_hub import snapshot_download
    except ImportError as error:
        raise RuntimeError("먼저 `npm run setup:stt`로 huggingface_hub 의존성을 설치하세요.") from error

    target_dir = asset_root / "whisper" / repo_id.split("/")[-1]

    if (target_dir / "model.bin").is_file():
        print(f"skip {target_dir}")
        return

    print(f"download {repo_id}")
    snapshot_download(
        repo_id=repo_id,
        local_dir=target_dir,
        local_dir_use_symlinks=False,
        allow_patterns=["*.json", "*.txt", "*.bin", "*.model"],
    )


def main() -> int:
    """필요한 모든 모델 파일을 다운로드하고 standalone 자산 폴더를 만든다."""

    args = parse_args()
    asset_root = Path(args.asset_root).resolve()
    asset_root.mkdir(parents=True, exist_ok=True)
    prepare_sherpa_diarization(asset_root)
    prepare_whisper_model(asset_root, args.whisper_repo_id)
    shutil.rmtree(asset_root / ".locks", ignore_errors=True)
    print(f"engine assets ready: {asset_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
