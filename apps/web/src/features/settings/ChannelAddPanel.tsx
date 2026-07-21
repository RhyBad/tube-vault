/**
 * ChannelAddPanel — the "add a channel" form (EP-30). Type is chosen first and is
 * immutable after creation (switching type resets the config draft). New channels
 * subscribe to all events at Info by default (server-side), so this form is just
 * type + name + per-type config — events/severity are tuned later in edit (§4).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  NOTIFICATION_CHANNEL_TYPES,
  type CreateNotificationChannelRequest,
  type NotificationChannelType,
} from '@tubevault/types';

import { Button, Tabs, TextField, type SecretChange, type TabItem } from '../../ds';
import { ChannelForm } from './ChannelForm';
import { buildConfig } from './settings-presentation';

const NO_STORED_SECRETS: ReadonlySet<string> = new Set();

export interface ChannelAddPanelProps {
  onCancel: () => void;
  /** Resolves → the parent closes the panel; rejects (400) → shown inline here. */
  onSubmit: (body: CreateNotificationChannelRequest) => Promise<void>;
}

export function ChannelAddPanel({ onCancel, onSubmit }: ChannelAddPanelProps): React.ReactElement {
  const { t } = useTranslation();

  const [type, setType] = useState<NotificationChannelType>('TELEGRAM');
  const [name, setName] = useState('');
  const [plain, setPlain] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, SecretChange>>({});
  const [invalidKeys, setInvalidKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [nameError, setNameError] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // §S9-5: title-case the tab labels (Telegram/Discord/…); the per-row type chip
  // stays uppercase. value keeps the canonical enum.
  const typeTabs: TabItem[] = NOTIFICATION_CHANNEL_TYPES.map((ty) => ({
    value: ty,
    label: ty.charAt(0) + ty.slice(1).toLowerCase(),
  }));

  const changeType = (next: string): void => {
    setType(next as NotificationChannelType);
    // Config shape differs per type — reset the draft so no stale keys leak.
    setPlain({});
    setSecrets({});
    setInvalidKeys(new Set());
    setAddError(null);
  };

  const handleSubmit = (): void => {
    const trimmed = name.trim();
    const { config, invalid } = buildConfig(type, plain, secrets, NO_STORED_SECRETS);
    if (trimmed === '' || invalid.length > 0) {
      setNameError(trimmed === '');
      setInvalidKeys(new Set(invalid));
      setAddError(t('settings.channels.form.checkFields'));
      return;
    }
    setNameError(false);
    setInvalidKeys(new Set());
    setAddError(null);
    setSaving(true);
    // config is assembled from the type's configFields (mirrors the per-type
    // schema) and the server re-validates — bridge the Record to the discriminated
    // request shape through unknown.
    const body = { type, name: trimmed, config } as unknown as CreateNotificationChannelRequest;
    onSubmit(body).catch((err: unknown) => {
      setSaving(false);
      setAddError(err instanceof Error ? err.message : t('settings.channels.form.checkFields'));
    });
  };

  return (
    <div className="tv-set-ch__add">
      <div className="tv-set-ch__addhead">
        <span className="tv-set-ch__addtitle">{t('settings.channels.addPick')}</span>
        <span className="tv-set-ch__addsub">{t('settings.channels.typeImmutable')}</span>
      </div>

      <Tabs tabs={typeTabs} value={type} onChange={changeType} />

      <div className="tv-set-ch__addbody">
        <TextField
          label={t('settings.channels.form.name')}
          value={name}
          placeholder={t('settings.channels.form.namePlaceholder')}
          error={nameError ? t('settings.channels.form.required') : undefined}
          disabled={saving}
          onChange={(v) => {
            setName(v);
            setNameError(false);
          }}
        />
        <ChannelForm
          type={type}
          plain={plain}
          onPlainChange={(key, value) => setPlain((cur) => ({ ...cur, [key]: value }))}
          onSecretChange={(key, change) => setSecrets((cur) => ({ ...cur, [key]: change }))}
          storedSecretKeys={NO_STORED_SECRETS}
          invalidKeys={invalidKeys}
          disabled={saving}
        />
        <span className="tv-set-ch__note">{t('settings.channels.addAllEventsNote')}</span>
      </div>

      {addError !== null && (
        <span className="tv-set-field__error" role="alert">
          {addError}
        </span>
      )}

      <div className="tv-set-ch__addfoot">
        <Button variant="primary" size="sm" onClick={handleSubmit} disabled={saving}>
          {saving ? t('settings.common.saving') : t('settings.channels.create')}
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={saving}>
          {t('settings.channels.form.cancel')}
        </Button>
      </div>
    </div>
  );
}
