import { Check, ListChecks, RotateCcw, X } from 'lucide-react';
import type { TranscriptSegment } from '../../../shared/types';
import { formatDuration } from '../utils/time';

export type TranscriptionReviewChoice = 'original' | 'refined';

export interface TranscriptionReviewItem {
  id: string;
  startMs: number;
  endMs: number;
  originalSegments: TranscriptSegment[];
  refinedSegments: TranscriptSegment[];
}

interface TranscriptionReviewPanelProps {
  items: TranscriptionReviewItem[];
  choices: Record<string, TranscriptionReviewChoice>;
  disabled?: boolean;
  onChoose(itemId: string, choice: TranscriptionReviewChoice): void;
  onChooseAll(choice: TranscriptionReviewChoice): void;
  onApply(): void;
  onCancel(): void;
}

export function TranscriptionReviewPanel({
  items,
  choices,
  disabled = false,
  onChoose,
  onChooseAll,
  onApply,
  onCancel
}: TranscriptionReviewPanelProps): JSX.Element {
  return (
    <section className="reviewPanel">
      <div className="reviewHeader">
        <div>
          <h2>최종 고품질 보정 검토</h2>
          <p>왼쪽은 현재 회의록, 오른쪽은 최종 보정 결과입니다. 적용할 문장을 선택하세요.</p>
        </div>
        <div className="reviewActions">
          <button className="ghostButton" disabled={disabled} type="button" onClick={() => onChooseAll('original')}>
            <RotateCcw size={16} />
            전체 원본
          </button>
          <button className="ghostButton" disabled={disabled} type="button" onClick={() => onChooseAll('refined')}>
            <ListChecks size={16} />
            전체 보정
          </button>
          <button className="primaryButton" disabled={disabled || items.length === 0} type="button" onClick={onApply}>
            <Check size={16} />
            선택 적용
          </button>
          <button className="ghostButton" disabled={disabled} type="button" onClick={onCancel}>
            <X size={16} />
            닫기
          </button>
        </div>
      </div>

      <div className="reviewList">
        {items.map((item) => {
          const choice = choices[item.id] ?? 'refined';

          return (
            <article className="reviewItem" key={item.id}>
              <div className="reviewTime">
                {formatDuration(item.startMs)} - {formatDuration(item.endMs)}
              </div>
              <button
                className={choice === 'original' ? 'reviewChoice active' : 'reviewChoice'}
                disabled={disabled || item.originalSegments.length === 0}
                type="button"
                onClick={() => onChoose(item.id, 'original')}
              >
                <strong>원본</strong>
                <span>{formatSegmentsText(item.originalSegments)}</span>
              </button>
              <button
                className={choice === 'refined' ? 'reviewChoice active' : 'reviewChoice'}
                disabled={disabled || item.refinedSegments.length === 0}
                type="button"
                onClick={() => onChoose(item.id, 'refined')}
              >
                <strong>보정</strong>
                <span>{formatSegmentsText(item.refinedSegments)}</span>
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function formatSegmentsText(segments: TranscriptSegment[]): string {
  const text = segments.map((segment) => segment.text.trim()).filter(Boolean).join('\n');
  return text || '내용 없음';
}
