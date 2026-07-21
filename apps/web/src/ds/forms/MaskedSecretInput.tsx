/**
 * MaskedSecretInput — a WRITE-ONLY secret field for editing stored credentials.
 * A secret is never read back, so the field starts empty and the merge outcome
 * is inferred from the operator's action and surfaced as a color-coded status:
 *   • blank + existing   → KEEP   (leave the stored secret as-is)
 *   • typed              → SET    (replace it)
 *   • explicit clear     → DELETE (remove it)
 *   • blank + none       → EMPTY  (nothing stored)
 * onChange emits {value, action} so the settings form submits the right merge.
 *
 * NOT for login (S0): login has no "keep the old one" semantics — reuse the look
 * there, not this write-only widget.
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Icon } from '../icon/Icon';
import './field.css';
import './MaskedSecretInput.css';
import { IconButton } from './IconButton';

export type SecretAction = 'keep' | 'set' | 'delete' | 'empty';
export interface SecretChange {
  value: string;
  action: SecretAction;
}

export interface MaskedSecretInputProps {
  label: string;
  onChange: (change: SecretChange) => void;
  /** Whether a secret is already stored (drives keep vs empty). */
  hasExisting?: boolean;
  hint?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

function deriveAction(text: string, cleared: boolean, hasExisting: boolean): SecretAction {
  if (text !== '') return 'set';
  if (cleared && hasExisting) return 'delete';
  if (hasExisting) return 'keep';
  return 'empty';
}

export function MaskedSecretInput({
  label,
  onChange,
  hasExisting = true,
  hint,
  disabled = false,
  id,
  className,
}: MaskedSecretInputProps): React.ReactElement {
  const { t } = useTranslation();
  const autoId = useId();
  const inputId = id ?? autoId;
  const [text, setText] = useState('');
  const [cleared, setCleared] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const action = deriveAction(text, cleared, hasExisting);

  const emit = (nextText: string, nextCleared: boolean): void => {
    onChange({ value: nextText, action: deriveAction(nextText, nextCleared, hasExisting) });
  };
  const handleText = (v: string): void => {
    setText(v);
    setCleared(false);
    emit(v, false);
  };
  const handleClear = (): void => {
    setText('');
    setCleared(true);
    emit('', true);
  };

  const statusHint =
    action === 'set'
      ? t('forms.secret.setHint')
      : action === 'delete'
        ? t('forms.secret.deleteHint')
        : action === 'keep'
          ? t('forms.secret.keepHint')
          : t('forms.secret.emptyHint');
  const statusIntent = action === 'delete' ? 'danger' : action === 'set' ? 'brand' : 'muted';

  const placeholder =
    hasExisting && !cleared && text === ''
      ? t('forms.secret.placeholderUnchanged')
      : t('forms.secret.placeholderEnter');

  return (
    <div className={`tv-field tv-secret${className ? ` ${className}` : ''}`}>
      <label htmlFor={inputId} className="tv-field__label">
        {label}
      </label>
      <div className="tv-field__control tv-secret__control">
        <input
          id={inputId}
          className="tv-input tv-input--mono"
          type={revealed ? 'text' : 'password'}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          onChange={(e) => handleText(e.target.value)}
        />
        <IconButton
          size="sm"
          variant="ghost"
          label={revealed ? t('forms.secret.hide') : t('forms.secret.reveal')}
          onClick={() => setRevealed((r) => !r)}
          disabled={disabled}
        >
          <Icon name={revealed ? 'eye-off' : 'eye'} size={15} />
        </IconButton>
        {hasExisting && (
          <IconButton
            size="sm"
            variant="ghost"
            label={t('forms.secret.clear')}
            onClick={handleClear}
            disabled={disabled}
          >
            <Icon name="trash" size={15} />
          </IconButton>
        )}
      </div>
      {hint !== undefined && hint !== '' && <div className="tv-field__hint">{hint}</div>}
      <div className="tv-field__hint tv-secret__status" data-intent={statusIntent}>
        {statusHint}
      </div>
    </div>
  );
}
