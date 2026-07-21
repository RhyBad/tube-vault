/**
 * TextField — labelled text input with an optional leading icon, error state
 * (aria-invalid + red hint), and a plain hint line. The label is always
 * associated with the input so it is reachable by its accessible name.
 */
import { useId } from 'react';

import { Icon, type IconName } from '../icon/Icon';
import './field.css';

export interface TextFieldProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  /** When set, the field reads as invalid and this copy replaces the hint. */
  error?: string;
  hint?: string;
  /**
   * Make the message line a persistent assertive live region so an error is
   * ANNOUNCED the moment it appears (not just read on focus via aria-describedby).
   * Scoped to the hint text only — the label, input, and any `trailing` control
   * stay outside the region so their changes aren't announced. Opt-in (S0 login).
   */
  errorLive?: boolean;
  leadingIcon?: IconName;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
  mono?: boolean;
  id?: string;
  className?: string;
  /**
   * Accessible name for a field with no visible `label` (placeholder is NOT a
   * name — WCAG 3.3.2). Ignored when `label` is set (the label already names it).
   */
  ariaLabel?: string;
  /** Rendered inside `.tv-field__control` immediately after the input (e.g. a
   *  password reveal-eye IconButton). Omitted for every existing caller. */
  trailing?: React.ReactNode;
  /** Focus the input on mount (e.g. S0's login secret field). Omitted for every existing caller. */
  autoFocus?: boolean;
  /** Passed through to the input's `autocomplete` attribute. Omitted for every existing caller. */
  autoComplete?: string;
  /** Passed through to the input's `spellcheck` attribute (e.g. false on a secret
   *  field, so a revealed value gets no spell-check squiggles). Omitted → default. */
  spellCheck?: boolean;
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  error,
  hint,
  errorLive = false,
  leadingIcon,
  disabled = false,
  size = 'md',
  mono = false,
  id,
  className,
  ariaLabel,
  trailing,
  autoFocus,
  autoComplete,
  spellCheck,
}: TextFieldProps): React.ReactElement {
  const autoId = useId();
  const inputId = id ?? autoId;
  const messageId = `${inputId}-message`;
  const invalid = error !== undefined && error !== '';
  const message = invalid ? error : hint;

  return (
    <div className={`tv-field${className ? ` ${className}` : ''}`} data-size={size}>
      {label !== undefined && (
        <label htmlFor={inputId} className="tv-field__label">
          {label}
        </label>
      )}
      <div className="tv-field__control">
        {leadingIcon !== undefined && (
          <Icon name={leadingIcon} size={16} className="tv-field__icon" />
        )}
        <input
          id={inputId}
          className={`tv-input${leadingIcon !== undefined ? ' tv-input--with-icon' : ''}${mono ? ' tv-input--mono' : ''}`}
          type={type}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          autoComplete={autoComplete}
          spellCheck={spellCheck}
          aria-label={label === undefined ? ariaLabel : undefined}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={message !== undefined && message !== '' ? messageId : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
        {trailing}
      </div>
      {errorLive ? (
        // Persistent region so the error is announced when it appears. Empty (and
        // unstyled) until there is a message, so it adds no visual gap.
        <div
          id={messageId}
          className={
            message !== undefined && message !== ''
              ? `tv-field__hint${invalid ? ' tv-field__hint--error' : ''}`
              : undefined
          }
          aria-live="assertive"
        >
          {message}
        </div>
      ) : (
        message !== undefined &&
        message !== '' && (
          <div
            id={messageId}
            className={`tv-field__hint${invalid ? ' tv-field__hint--error' : ''}`}
          >
            {message}
          </div>
        )
      )}
    </div>
  );
}
