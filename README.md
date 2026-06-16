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

```bash
python3 -m venv .venv-stt
source .venv-stt/bin/activate
pip install -r engines/offline-whisperx/requirements.txt
brew install ffmpeg
```

화자분리 모델은 최초 1회 Hugging Face 약관 승인과 token이 필요합니다.

```bash
export MEETING_RECORDER_STT_PYTHON=".venv-stt/bin/python"
export MEETING_RECORDER_HF_TOKEN="hf_..."
```

한국어 전사는 기본값입니다. 내부적으로 `MEETING_RECORDER_STT_LANGUAGE=ko`와 `MEETING_RECORDER_STT_TASK=transcribe`를 사용해 한글 받아쓰기를 우선합니다. 모델을 내려받은 뒤 네트워크 없이 실행하려면 `MEETING_RECORDER_STT_OFFLINE=1`을 추가합니다. 동시에 말하는 구간은 `TranscriptSegment.isOverlapped`와 `overlapGroupId`로 저장합니다.
