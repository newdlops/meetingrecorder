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
npm run dev
```

## 오프라인 전사 엔진 준비

최종 사용자 앱은 Python 엔진, ffmpeg, STT 모델, 화자분리 모델을 포함해서 배포해야 합니다. 개발/릴리즈 준비 단계에서만 아래 명령을 실행합니다.

```bash
npm run setup:standalone
npm run dist
```

생성된 앱은 `release/` 아래에 만들어집니다. 한국어 전사는 기본값이며 내부적으로 `MEETING_RECORDER_STT_LANGUAGE=ko`와 `MEETING_RECORDER_STT_TASK=transcribe`를 사용합니다. 화자분리는 Hugging Face token이 필요 없는 `sherpa-onnx` 로컬 ONNX 모델을 사용합니다. 동시에 말하는 구간은 `TranscriptSegment.isOverlapped`와 `overlapGroupId`로 저장합니다.
