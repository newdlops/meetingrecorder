# Offline WhisperX Engine

이 엔진은 녹음 파일을 로컬 Python worker로 보내 `WhisperX + sherpa-onnx` 조합으로 전사와 화자분리를 수행합니다.

## 선택 이유

- WhisperX: Whisper 기반 전사, VAD, 단어 단위 타임스탬프를 제공
- sherpa-onnx: token이 필요 없는 로컬 ONNX 화자분리 모델을 제공
- 오프라인 동작: 릴리즈 전에 모델 파일을 앱 자산으로 포함하면 최종 사용자는 네트워크와 터미널 설정 없이 사용 가능

## 배포

```bash
npm run build:prod
```

`build:prod`는 `.venv-stt` Python 엔진, `engines/models` 모델 자산, `whisper.cpp` 바이너리를 먼저 준비한 뒤 `verify:engine-bundle`로 누락 여부를 검사합니다. 검증을 통과한 자산은 Electron 앱의 resources 폴더에 포함되므로 최종 사용자는 Python, STT 모델, 화자분리 모델을 별도로 설치하지 않습니다.

배포용 Python 환경은 Python 3.11과 `requirements-lock.txt`의 고정 버전을 사용합니다. 의존성을 갱신할 때는 호환성을 검증한 환경의 lock 파일도 함께 갱신해야 합니다.

기본 전사 엔진은 기존 `WhisperX`입니다. `whisper.cpp`는 설정에서 추가로 선택할 수 있으며, 정확도 손실을 피하기 위해 setup 단계에서 quantized 모델이 아닌 full precision `large-v3` 모델을 준비합니다.

## 주요 환경변수

- `MEETING_RECORDER_STT_PYTHON`: Python 실행 파일 경로. 지정하지 않으면 `.venv-stt/bin/python`을 자동 사용
- `MEETING_RECORDER_STT_MODEL`: Whisper 모델. 기본값: `large-v3`
- `MEETING_RECORDER_STT_DEVICE`: `cpu` 또는 `cuda`. 기본값: `cpu`
- `MEETING_RECORDER_STT_COMPUTE_TYPE`: 기본값: `int8`
- `MEETING_RECORDER_ENGINE_ASSET_ROOT`: standalone 모델 자산 루트. 기본값은 `engines/models`
- `MEETING_RECORDER_WHISPER_REVISION`: 번들에 받을 faster-whisper 모델 revision. 기본값은 검증된 고정 revision
- `MEETING_RECORDER_WHISPER_MODEL_SHA256`: faster-whisper repo/revision을 바꿀 때 필요한 `model.bin` SHA-256
- `MEETING_RECORDER_STT_MODEL_DIR`: Whisper 모델 디렉터리. 기본값은 `engines/models/whisper`
- `MEETING_RECORDER_STT_LANGUAGE`: 언어 고정값. 기본값은 한국어 `ko`
- `MEETING_RECORDER_STT_TASK`: `transcribe` 또는 `translate`. 기본값은 한글 받아쓰기용 `transcribe`
- `MEETING_RECORDER_STT_FINAL_DECODER`: 최종 전사 디코더. 기본값은 들린 음성 우선 `literal`, 빠른 처리만 원하면 `fast`, 문맥 보정을 원하면 `contextual`
- `MEETING_RECORDER_STT_FINAL_BEAM_SIZE`: 최종 전사 beam search 폭. 기본값은 `5`
- `MEETING_RECORDER_STT_INITIAL_PROMPT`: 문맥 보정이 필요할 때만 쓰는 전사 힌트 문장
- `MEETING_RECORDER_STT_HOTWORDS`: 회사명, 제품명, 참석자명처럼 우선 고려할 쉼표 구분 키워드
- `MEETING_RECORDER_STT_ALLOW_DOWNLOAD`: `1`이면 개발 중 모델 자동 다운로드를 허용. 기본값은 다운로드 금지
- `MEETING_RECORDER_STT_TIMEOUT_MS`: 긴 회의 처리 타임아웃
- `MEETING_RECORDER_WHISPER_CPP_MODEL_SHA256`: 기본 URL을 바꿀 때 사용할 whisper.cpp 모델 SHA-256
- `MEETING_RECORDER_WHISPER_CPP_SOURCE_SHA256`: whisper.cpp 소스 URL/버전을 바꿀 때 사용할 SHA-256

## 한국어 품질 기준

기본 모델은 다국어 정확도가 높은 `large-v3`이고, 언어는 `ko`, 작업은 `transcribe`로 고정됩니다. 녹음 중 미리보기는 응답성을 위해 빠른 WhisperX batched 경로를 쓰고, 최종 저장 전사는 같은 모델을 재사용하되 `faster-whisper` 표준 디코더의 단어 타임스탬프를 사용합니다. 기본 최종 전사는 `literal` 모드라 이전 문장 참조, 기본 프롬프트, temperature fallback을 쓰지 않아 의미 추론으로 생기는 환각을 줄입니다. worker는 단어 조각을 합칠 때 강제 공백 삽입을 피해서 한글 어절이 `안 녕 하 세 요`처럼 깨지는 문제를 줄입니다.
