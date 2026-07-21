/**
 * NumberStepper — a bounded integer control (download concurrency 1–4). It never
 * emits a value outside [min,max]: the buttons disable at the bounds and the
 * handlers clamp. The value reads in tabular mono so it doesn't jitter.
 */
import { useTranslation } from 'react-i18next';

import { Icon } from '../icon/Icon';
import './NumberStepper.css';

export interface NumberStepperProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  label?: string;
  suffix?: string;
  id?: string;
  className?: string;
}

export function NumberStepper({
  value,
  min = 1,
  max = 4,
  step = 1,
  onChange,
  disabled = false,
  label,
  suffix,
  id,
  className,
}: NumberStepperProps): React.ReactElement {
  const { t } = useTranslation();
  const labelId = id !== undefined ? `${id}-label` : undefined;

  const decrement = (): void => {
    const next = value - step;
    if (next >= min) onChange(next);
  };
  const increment = (): void => {
    const next = value + step;
    if (next <= max) onChange(next);
  };

  return (
    <div className={`tv-stepper${className ? ` ${className}` : ''}`}>
      {label !== undefined && (
        <span className="tv-stepper__label" id={labelId}>
          {label}
        </span>
      )}
      <div className="tv-stepper__control" role="group" aria-labelledby={labelId}>
        <button
          type="button"
          className="tv-stepper__btn"
          aria-label={t('forms.stepper.decrement')}
          disabled={disabled || value <= min}
          onClick={decrement}
        >
          <Icon name="minus" size={14} />
        </button>
        <span className="tv-stepper__value tv-numeric">
          {value}
          {suffix !== undefined && <span className="tv-stepper__suffix">{suffix}</span>}
        </span>
        <button
          type="button"
          className="tv-stepper__btn"
          aria-label={t('forms.stepper.increment')}
          disabled={disabled || value >= max}
          onClick={increment}
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
    </div>
  );
}
