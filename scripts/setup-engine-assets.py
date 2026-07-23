#!/usr/bin/env python3
"""standalone 배포에 포함할 오프라인 STT/화자분리 모델 자산을 준비한다."""

from __future__ import annotations

import argparse
import bz2
import hashlib
import os
import shutil
import tarfile
import urllib.request
import uuid
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
WHISPER_REVISION = "edaa852ec7e145841d8ffdb056a99866b5f0a478"
WHISPER_MODEL_SHA256 = "69f74147e3334731bc3a76048724833325d2ec74642fb52620eda87352e3d4f1"
WHISPER_FILE_SHA256 = {
    "model.bin": WHISPER_MODEL_SHA256,
    "config.json": "a9306624f5ec14270a014b647e5c316b6e03a662c369758d1b90697a7b0655b9",
    "tokenizer.json": "6d8cbd7cd0d8d5815e478dac67b85a26bbe77c1f5e0c6d76d1ce2abc0e5f21ca",
    "vocabulary.json": "c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1",
    "preprocessor_config.json": "7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711",
}
SEGMENTATION_SHA256 = "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488"
EMBEDDING_SHA256 = "1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b"


def parse_args() -> argparse.Namespace:
    """모델 저장 위치와 Whisper 모델 ID를 CLI 인자로 받는다."""

    parser = argparse.ArgumentParser(description="Prepare bundled offline engine models")
    parser.add_argument("--asset-root", default=str(DEFAULT_ASSET_ROOT), help="모델을 저장할 앱 자산 루트")
    parser.add_argument("--whisper-repo-id", default=WHISPER_REPO_ID, help="faster-whisper CTranslate2 모델 repo")
    parser.add_argument(
        "--whisper-revision",
        default=os.environ.get("MEETING_RECORDER_WHISPER_REVISION", WHISPER_REVISION),
        help="고정할 faster-whisper 모델 revision",
    )
    parser.add_argument(
        "--whisper-sha256",
        default=os.environ.get("MEETING_RECORDER_WHISPER_MODEL_SHA256"),
        help="faster-whisper model.bin SHA-256",
    )
    return parser.parse_args()


def calculate_sha256(file_path: Path) -> str:
    digest = hashlib.sha256()

    with file_path.open("rb") as input_file:
        for chunk in iter(lambda: input_file.read(1024 * 1024), b""):
            digest.update(chunk)

    return digest.hexdigest()


def verify_sha256(file_path: Path, expected_sha256: str) -> None:
    actual_sha256 = calculate_sha256(file_path)

    if actual_sha256 != expected_sha256:
        raise RuntimeError(
            f"모델 체크섬이 일치하지 않습니다: {file_path} "
            f"(expected {expected_sha256}, got {actual_sha256})"
        )


def download_file(url: str, target_path: Path, expected_sha256: str) -> None:
    """파일을 임시 경로에 내려받고 체크섬을 검증한 뒤 원자적으로 배치한다."""

    target_path.parent.mkdir(parents=True, exist_ok=True)

    if target_path.is_file():
        try:
            verify_sha256(target_path, expected_sha256)
            print(f"skip {target_path}")
            return
        except RuntimeError:
            print(f"redownload {target_path}: checksum mismatch")
            target_path.unlink()

    print(f"download {url}")
    temporary_path = target_path.with_name(
        f".{target_path.name}.{os.getpid()}.{uuid.uuid4().hex}.download"
    )

    try:
        urllib.request.urlretrieve(url, temporary_path)
        verify_sha256(temporary_path, expected_sha256)
        temporary_path.replace(target_path)
    finally:
        temporary_path.unlink(missing_ok=True)


def extract_tar_safely(archive: tarfile.TarFile, target_directory: Path) -> None:
    """절대경로, 상위경로, 링크가 포함된 모델 archive를 거부한다."""

    resolved_target = target_directory.resolve()
    members = archive.getmembers()

    for member in members:
        member_path = (resolved_target / member.name).resolve()

        if (
            not member_path.is_relative_to(resolved_target)
            or not (member.isfile() or member.isdir())
            or member.issym()
            or member.islnk()
        ):
            raise RuntimeError(f"안전하지 않은 모델 archive 항목입니다: {member.name}")

    archive.extractall(resolved_target, members=members)


def prepare_sherpa_diarization(asset_root: Path) -> None:
    """sherpa-onnx 화자분리 모델 두 개를 로컬 자산 폴더에 준비한다."""

    diarization_root = asset_root / "diarization"
    archive_path = diarization_root / "sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
    segmentation_dir = diarization_root / "sherpa-onnx-pyannote-segmentation-3-0"
    embedding_path = diarization_root / "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"

    download_file(SEGMENTATION_URL, archive_path, SEGMENTATION_SHA256)
    download_file(EMBEDDING_URL, embedding_path, EMBEDDING_SHA256)

    if not (segmentation_dir / "model.onnx").is_file():
        print(f"extract {archive_path}")
        with bz2.open(archive_path, "rb") as compressed_file:
            with tarfile.open(fileobj=compressed_file, mode="r:") as tar:
                extract_tar_safely(tar, diarization_root)


def prepare_whisper_model(
    asset_root: Path,
    repo_id: str,
    revision: str,
    expected_file_sha256: dict[str, str],
) -> None:
    """faster-whisper 모델을 앱 자산 폴더에 snapshot 형태로 내려받는다."""

    try:
        from huggingface_hub import snapshot_download
    except ImportError as error:
        raise RuntimeError("먼저 `npm run setup:stt`로 huggingface_hub 의존성을 설치하세요.") from error

    target_dir = asset_root / "whisper" / repo_id.split("/")[-1]

    required_files = [
        target_dir / "model.bin",
        target_dir / "config.json",
        target_dir / "tokenizer.json",
        target_dir / "vocabulary.json",
        target_dir / "preprocessor_config.json",
    ]
    metadata_path = target_dir / ".cache" / "huggingface" / "download" / "model.bin.metadata"
    stored_revision = metadata_path.read_text(encoding="utf-8").splitlines()[0] if metadata_path.is_file() else ""
    if any((target_dir / file_name).is_file() for file_name in expected_file_sha256):
        try:
            for file_name, expected_sha256 in expected_file_sha256.items():
                file_path = target_dir / file_name

                if file_path.is_file():
                    verify_sha256(file_path, expected_sha256)
        except RuntimeError:
            print(f"redownload {target_dir}: model asset checksum mismatch")
            shutil.rmtree(target_dir)
            stored_revision = ""

    if all(file_path.is_file() and file_path.stat().st_size > 0 for file_path in required_files) and stored_revision == revision:
        print(f"skip {target_dir}")
        return

    print(f"download {repo_id}@{revision}")
    snapshot_download(
        repo_id=repo_id,
        revision=revision,
        local_dir=target_dir,
        local_dir_use_symlinks=False,
        allow_patterns=["*.json", "*.txt", "*.bin", "*.model"],
    )
    for file_name, expected_sha256 in expected_file_sha256.items():
        verify_sha256(target_dir / file_name, expected_sha256)


def main() -> int:
    """필요한 모든 모델 파일을 다운로드하고 standalone 자산 폴더를 만든다."""

    args = parse_args()
    asset_root = Path(args.asset_root).resolve()
    asset_root.mkdir(parents=True, exist_ok=True)
    prepare_sherpa_diarization(asset_root)
    whisper_sha256 = args.whisper_sha256
    is_default_whisper_model = args.whisper_repo_id == WHISPER_REPO_ID and args.whisper_revision == WHISPER_REVISION

    if not whisper_sha256 and is_default_whisper_model:
        whisper_sha256 = WHISPER_MODEL_SHA256

    if not whisper_sha256:
        raise RuntimeError("커스텀 Whisper 모델에는 --whisper-sha256 또는 MEETING_RECORDER_WHISPER_MODEL_SHA256가 필요합니다.")

    expected_file_sha256 = dict(WHISPER_FILE_SHA256) if is_default_whisper_model else {"model.bin": whisper_sha256}
    prepare_whisper_model(asset_root, args.whisper_repo_id, args.whisper_revision, expected_file_sha256)
    shutil.rmtree(asset_root / ".locks", ignore_errors=True)
    print(f"engine assets ready: {asset_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
