/**
 * Select — a native <select> under the DS skin (keeps native keyboard + a11y),
 * with a custom chevron. Options accept plain strings or {value,label}.
 */
import { useId } from 'react';

import { Icon } from '../icon/Icon';
import './field.css';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: Array<string | SelectOption>;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
  id?: string;
  className?: string;
}

export function Select({
  value,
  onChange,
  options,
  label,
  placeholder,
  disabled = false,
  size = 'md',
  id,
  className,
}: SelectProps): React.ReactElement {
  const autoId = useId();
  const selectId = id ?? autoId;
  const normalized: SelectOption[] = options.map((o) =>
    typeof o === 'string' ? { value: o, label: o } : o,
  );

  return (
    <div className={`tv-field${className ? ` ${className}` : ''}`} data-size={size}>
      {label !== undefined && (
        <label htmlFor={selectId} className="tv-field__label">
          {label}
        </label>
      )}
      <div className="tv-field__control tv-select">
        <select
          id={selectId}
          className="tv-input tv-select__native"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          {placeholder !== undefined && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {normalized.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Icon name="chevron-down" size={16} className="tv-select__chevron" />
      </div>
    </div>
  );
}
