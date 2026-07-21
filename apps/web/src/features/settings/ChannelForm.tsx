/**
 * ChannelForm — the per-type config field grid shared by the add and edit panels.
 * Iterates the type's `configFields` (§4): secret keys render a write-only
 * MaskedSecretInput (starts empty, `hasExisting` from the stored config so blank
 * = keep), plain keys a TextField. The parent owns the field state; this only
 * renders + reports changes. The name/events/severity live in the parents.
 */
import { useTranslation } from 'react-i18next';

import type { NotificationChannelType } from '@tubevault/types';

import { MaskedSecretInput, TextField, type SecretChange } from '../../ds';
import { configFields } from './settings-presentation';

export interface ChannelFormProps {
  type: NotificationChannelType;
  /** Current plain (non-secret) field values, keyed by config key. */
  plain: Readonly<Record<string, string>>;
  onPlainChange: (key: string, value: string) => void;
  onSecretChange: (key: string, change: SecretChange) => void;
  /** Secret keys with a value already stored (edit) → MaskedSecretInput keep mode. */
  storedSecretKeys: ReadonlySet<string>;
  /** Config keys that failed validation (rendered as required errors). */
  invalidKeys: ReadonlySet<string>;
  disabled?: boolean;
}

export function ChannelForm({
  type,
  plain,
  onPlainChange,
  onSecretChange,
  storedSecretKeys,
  invalidKeys,
  disabled = false,
}: ChannelFormProps): React.ReactElement {
  const { t } = useTranslation();

  return (
    <div className="tv-set-ch__grid">
      {configFields(type).map((field) => {
        const baseLabel = t(`settings.channels.fields.${field.key}`);
        const label = field.optional
          ? `${baseLabel} · ${t('settings.channels.form.optionalTag')}`
          : baseLabel;
        const invalid = invalidKeys.has(field.key);

        if (field.secret) {
          return (
            <MaskedSecretInput
              key={field.key}
              label={label}
              hasExisting={storedSecretKeys.has(field.key)}
              hint={invalid ? t('settings.channels.form.required') : undefined}
              disabled={disabled}
              onChange={(change) => onSecretChange(field.key, change)}
            />
          );
        }
        return (
          <TextField
            key={field.key}
            label={label}
            value={plain[field.key] ?? ''}
            // §S9-6/M2: config values (URLs/IDs/tokens) read in tabular mono, with a
            // format-example placeholder — matching the design + the secret fields.
            mono
            placeholder={field.placeholder}
            disabled={disabled}
            error={invalid ? t('settings.channels.form.required') : undefined}
            onChange={(value) => onPlainChange(field.key, value)}
          />
        );
      })}
    </div>
  );
}
