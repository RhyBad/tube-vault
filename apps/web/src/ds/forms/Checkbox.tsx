/**
 * Checkbox — a real native checkbox under a themed skin, so it keeps native
 * keyboard + a11y semantics and the tri-state `indeterminate` flag (the DataTable
 * "some selected" header). `indeterminate` is a DOM property, not an attribute,
 * so it is applied via a ref. Pass `hideLabel` for a control that needs an
 * accessible name but no visible text.
 */
import { useEffect, useId, useRef } from 'react';

import './Checkbox.css';

export interface CheckboxProps {
  checked?: boolean;
  indeterminate?: boolean;
  onChange?: (checked: boolean) => void;
  label?: string;
  hideLabel?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
}

export function Checkbox({
  checked = false,
  indeterminate = false,
  onChange,
  label,
  hideLabel = false,
  disabled = false,
  id,
  className,
}: CheckboxProps): React.ReactElement {
  const autoId = useId();
  const inputId = id ?? autoId;
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <span className={`tv-checkbox${className ? ` ${className}` : ''}`}>
      <input
        ref={ref}
        id={inputId}
        type="checkbox"
        className="tv-checkbox__input"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
      />
      {label !== undefined && (
        <label htmlFor={inputId} className={`tv-checkbox__label${hideLabel ? ' tv-sr-only' : ''}`}>
          {label}
        </label>
      )}
    </span>
  );
}
