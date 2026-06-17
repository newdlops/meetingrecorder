import { Brain, Cpu, Settings2 } from 'lucide-react';
import type { TranscriptionInferenceMode } from '../../../shared/types';

interface ProcessingSettingsPanelProps {
  disabled?: boolean;
  inferenceMode: TranscriptionInferenceMode;
  maxWorkerCount: number;
  minWorkerCount: number;
  workerCount: number;
  onInferenceModeChange(value: TranscriptionInferenceMode): void;
  onWorkerCountChange(value: number): void;
}

const INFERENCE_MODE_OPTIONS: Array<{
  value: TranscriptionInferenceMode;
  label: string;
  tooltip: string;
}> = [
  {
    value: 'literal',
    label: '의미 추정하지 않음',
    tooltip: '음절단위 전사'
  },
  {
    value: 'contextual',
    label: '의미 추정',
    tooltip: '문맥 파악 수정'
  }
];

export function ProcessingSettingsPanel({
  disabled = false,
  inferenceMode,
  maxWorkerCount,
  minWorkerCount,
  workerCount,
  onInferenceModeChange,
  onWorkerCountChange
}: ProcessingSettingsPanelProps): JSX.Element {
  const handleChange = (value: number): void => {
    const normalizedValue = Math.max(minWorkerCount, Math.min(maxWorkerCount, Math.round(value)));
    onWorkerCountChange(normalizedValue);
  };

  return (
    <aside className="processingSettingsPanel">
      <div className="panelTitle">
        <Settings2 size={18} />
        <h2>처리 설정</h2>
      </div>

      <label className="workerCountControl">
        <span>
          <Cpu size={15} />
          전사 워커 {workerCount}개
        </span>
        <div className="workerCountInputs">
          <input
            disabled={disabled}
            max={maxWorkerCount}
            min={minWorkerCount}
            step={1}
            type="range"
            value={workerCount}
            onChange={(event) => handleChange(Number(event.target.value))}
          />
          <input
            aria-label="전사 워커 수"
            disabled={disabled}
            max={maxWorkerCount}
            min={minWorkerCount}
            step={1}
            type="number"
            value={workerCount}
            onChange={(event) => handleChange(Number(event.target.value))}
          />
        </div>
      </label>

      <div className="inferenceModeControl">
        <span>
          <Brain size={15} />
          전사 방식
        </span>
        <div className="inferenceModeOptions">
          {INFERENCE_MODE_OPTIONS.map((option) => (
            <button
              aria-pressed={inferenceMode === option.value}
              className={inferenceMode === option.value ? 'active' : undefined}
              disabled={disabled}
              key={option.value}
              title={option.tooltip}
              type="button"
              onClick={() => onInferenceModeChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
