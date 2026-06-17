import type { MeetingSession } from './types';

// 전사 구간을 사용자가 편집 가능한 일반 텍스트 본문으로 변환한다.
export function buildTranscriptText(session: MeetingSession): string {
  const speakerMap = new Map(session.speakers.map((speaker) => [speaker.id, speaker.name]));
  const lines = session.segments.map((segment) => {
    const speakerName = speakerMap.get(segment.speakerId) ?? '알 수 없는 화자';
    const overlapLabel = segment.isOverlapped ? ' [동시 발화]' : '';
    return `[${formatTranscriptTime(segment.startMs)} - ${formatTranscriptTime(
      segment.endMs
    )}] ${speakerName}${overlapLabel}: ${segment.text}`;
  });

  return lines.join('\n');
}

// 저장하거나 내보낼 때 제목, 전사 본문, 메모를 하나의 문서로 조립한다.
export function formatTranscriptDocument(session: MeetingSession): string {
  const transcriptText = (session.transcriptText || buildTranscriptText(session)).trim();
  const memo = session.memo.trim();
  const segmentMemos = session.segments
    .filter((segment) => segment.memo?.trim())
    .map((segment) => `- [${formatTranscriptTime(segment.startMs)}] ${segment.memo?.trim()}`);
  const header = [`# ${session.title}`, `생성: ${session.createdAt}`, `수정: ${session.updatedAt}`, ''];
  const memoBlock = memo ? ['', '## 메모', memo] : [];
  const segmentMemoBlock = segmentMemos.length > 0 ? ['', '## 문장 메모', ...segmentMemos] : [];

  return [...header, transcriptText, ...memoBlock, ...segmentMemoBlock, ''].join('\n');
}

// 밀리초 시간을 텍스트 회의록용 mm:ss 형식으로 바꾼다.
function formatTranscriptTime(valueMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(valueMs / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}
