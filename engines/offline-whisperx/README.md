# Offline WhisperX Engine

이 엔진은 녹음 파일을 로컬 Python worker로 보내 `WhisperX + pyannote.audio` 조합으로 전사와 화자분리를 수행합니다.

## 선택 이유

- WhisperX: Whisper 기반 전사, VAD, 단어 단위 타임스탬프, pyannote 화자 라벨 할당을 제공
- pyannote.audio: 화자분리, 발화 구간 탐지, 겹침 발화 탐지 계열 모델 제공
- 오프라인 동작: 최초 모델 다운로드와 Hugging Face 약관 동의 후 로컬 캐시만 사용 가능

## 설치

```bash
python3 -m venv .venv-stt
source .venv-stt/bin/activate
pip install -r engines/offline-whisperx/requirements.txt
```

macOS에서는 `ffmpeg`도 필요합니다.

```bash
brew install ffmpeg
```

화자분리를 처음 사용할 때는 Hugging Face에서 `pyannote/speaker-diarization-community-1` 모델 약관을 승인하고 read token을 만들어야 합니다.

```bash
export MEETING_RECORDER_HF_TOKEN="hf_..."
```

모델을 한 번 내려받은 뒤 완전 오프라인으로 실행하려면 아래 값을 추가합니다.

```bash
export MEETING_RECORDER_STT_OFFLINE=1
```

## 주요 환경변수

- `MEETING_RECORDER_STT_PYTHON`: Python 실행 파일 경로. 예: `.venv-stt/bin/python`
- `MEETING_RECORDER_STT_MODEL`: Whisper 모델. 기본값: `large-v3`
- `MEETING_RECORDER_STT_DEVICE`: `cpu` 또는 `cuda`. 기본값: `cpu`
- `MEETING_RECORDER_STT_COMPUTE_TYPE`: 기본값: `int8`
- `MEETING_RECORDER_STT_MODEL_DIR`: 모델 캐시 디렉터리
- `MEETING_RECORDER_STT_LANGUAGE`: 언어 고정값. 기본값은 한국어 `ko`
- `MEETING_RECORDER_STT_TASK`: `transcribe` 또는 `translate`. 기본값은 한글 받아쓰기용 `transcribe`
- `MEETING_RECORDER_STT_TIMEOUT_MS`: 긴 회의 처리 타임아웃

## 한국어 품질 기준

기본 모델은 다국어 정확도가 높은 `large-v3`이고, 언어는 `ko`, 작업은 `transcribe`로 고정됩니다. worker는 WhisperX 단어 조각을 합칠 때 강제 공백 삽입을 피해서 한글 어절이 `안 녕 하 세 요`처럼 깨지는 문제를 줄입니다.
