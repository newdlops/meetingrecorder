# Meeting Recorder

회의 녹음, 실시간 전사, 화자 구분, 회의록 저장을 위한 Electron 기반 데스크톱 앱입니다.

## 현재 세팅

- Electron + React + TypeScript + electron-vite
- 마이크 녹음: 브라우저 `MediaRecorder` 기반
- 전사/화자분리: 로컬 `WhisperX + pyannote.audio` worker 기반
- 저장: Electron 메인 프로세스가 앱 데이터 폴더에 오디오와 회의 JSON, 텍스트 스냅샷 저장
- 목록: 저장된 회의 목록 조회, 상세 보기, 화자명 수정, 텍스트 내보내기

## 실행

```bash
npm install
npm run build:system-audio
npm run dev
```

시스템 오디오 권한 팝업 없이 UI와 전사 저장 흐름만 개발 테스트할 때는 mock 시스템 오디오 모드를 사용합니다.

```bash
npm run dev:mock-system-audio
```

macOS에서 시스템 오디오 캡처 권한을 실수로 거절했다면 아래 명령으로 개발용 헬퍼의 TCC 상태를 초기화한 뒤 앱을 다시 시작합니다.

```bash
npm run reset:system-audio-permission
```

## 오프라인 전사 엔진 준비

최종 사용자 앱은 Python 엔진, ffmpeg, STT 모델, 화자분리 모델을 포함해서 배포해야 합니다. 배포 명령은 standalone 엔진 준비, 자산 검증, 패키징을 순서대로 실행합니다.

```bash
npm run build:prod
```

생성된 앱은 `release/` 아래에 만들어집니다. 패키징 전에 `verify:engine-bundle`이 Python 런타임, STT 모델, 화자분리 모델, `whisper.cpp` 바이너리와 full precision 모델이 모두 포함 가능한 상태인지 확인합니다. 한국어 전사는 기본값이며 내부적으로 `MEETING_RECORDER_STT_LANGUAGE=ko`와 `MEETING_RECORDER_STT_TASK=transcribe`를 사용합니다. 화자분리는 Hugging Face token이 필요 없는 `sherpa-onnx` 로컬 ONNX 모델을 사용합니다. 동시에 말하는 구간은 `TranscriptSegment.isOverlapped`와 `overlapGroupId`로 저장합니다.

설정 화면의 기본 전사 엔진은 기존 고정밀 `WhisperX`입니다. `whisper.cpp`는 추가 엔진으로 선택할 수 있으며, `setup:standalone`이 `whisper-cli`와 full precision `large-v3` 모델을 함께 준비합니다. 이미 빌드된 `whisper-cli`가 있으면 `MEETING_RECORDER_WHISPER_CPP_BINARY`로 지정해 배포 자산에 복사할 수 있습니다.
