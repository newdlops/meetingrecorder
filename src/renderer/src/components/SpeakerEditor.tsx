import { Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { MeetingSession } from '../../../shared/types';

interface SpeakerEditorProps {
  session: MeetingSession | null;
  disabled: boolean;
  onRename(speakerId: string, name: string): void;
}

// 회의별 화자 이름을 편집하는 패널이다.
export function SpeakerEditor({ session, disabled, onRename }: SpeakerEditorProps): JSX.Element {
  const [draftNames, setDraftNames] = useState<Record<string, string>>({});

  useEffect(() => {
    const nextDrafts = Object.fromEntries(session?.speakers.map((speaker) => [speaker.id, speaker.name]) ?? []);
    setDraftNames(nextDrafts);
  }, [session]);

  // 입력이 끝난 화자명을 상위 상태 또는 저장소에 반영한다.
  const commitName = (speakerId: string): void => {
    const nextName = draftNames[speakerId]?.trim();
    const currentName = session?.speakers.find((speaker) => speaker.id === speakerId)?.name;

    if (nextName && nextName !== currentName) {
      onRename(speakerId, nextName);
    }
  };

  return (
    <aside className="speakerPanel">
      <div className="panelTitle">
        <Users size={18} />
        <h2>화자</h2>
      </div>

      {!session ? (
        <p className="emptyText">선택된 회의가 없습니다.</p>
      ) : (
        <div className="speakerList">
          {session.speakers.map((speaker) => (
            <label className="speakerRow" key={speaker.id}>
              <span className="speakerSwatch" style={{ backgroundColor: speaker.color }} />
              <input
                disabled={disabled}
                value={draftNames[speaker.id] ?? speaker.name}
                onBlur={() => commitName(speaker.id)}
                onChange={(event) =>
                  setDraftNames((current) => ({ ...current, [speaker.id]: event.target.value }))
                }
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.currentTarget.blur();
                  }
                }}
              />
            </label>
          ))}
        </div>
      )}
    </aside>
  );
}
