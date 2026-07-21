/**
 * ChannelEditPanel — a channel's inline edit form (EP-31). Mounts only while a row
 * is editing, so its draft initializes fresh from the channel each time it opens.
 * Secrets follow the keep/delete/replace merge (§4): the fields start empty, and
 * a blank secret keeps the stored value. Events + min-severity are editable here
 * (they default at create time, tuned after — §4). Client validation flags empty
 * required fields before any round-trip; a server 400 shows inline.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_SEVERITIES,
  type NotificationChannelDto,
  type NotificationEventType,
  type NotificationSeverity,
  type UpdateNotificationChannelRequest,
} from '@tubevault/types';

import { ApiError } from '../../lib/api';
import { Button, Checkbox, Icon, Select, type SecretChange, type SelectOption } from '../../ds';
import { ChannelForm } from './ChannelForm';
import { buildConfig, configFields, eventsSummary } from './settings-presentation';

// §S9-10: each notification event id → its human i18n label key. `as const` keeps
// the values literal so t(EVENT_LABEL_KEY[ev]) stays a valid typed-key union.
const EVENT_LABEL_KEY = {
  'download.failed': 'settings.channels.form.eventLabels.downloadFailed',
  'storage.near_full': 'settings.channels.form.eventLabels.storageNearFull',
  'storage.paused': 'settings.channels.form.eventLabels.storagePaused',
  'source.gone': 'settings.channels.form.eventLabels.sourceGone',
  'video.rescued': 'settings.channels.form.eventLabels.videoRescued',
  'live.start': 'settings.channels.form.eventLabels.liveStart',
  'live.stop': 'settings.channels.form.eventLabels.liveStop',
  'session.expired': 'settings.channels.form.eventLabels.sessionExpired',
  'system.test': 'settings.channels.form.eventLabels.systemTest',
  'worker.stalled': 'settings.channels.form.eventLabels.workerStalled',
  'youtube.bot_wall': 'settings.channels.form.eventLabels.youtubeBotWall',
} as const satisfies Record<NotificationEventType, string>;

export interface ChannelEditPanelProps {
  channel: NotificationChannelDto;
  onCancel: () => void;
  /** Resolves → the parent closes the panel; rejects (400) → shown inline here. */
  onSubmit: (body: UpdateNotificationChannelRequest) => Promise<void>;
}

export function ChannelEditPanel({
  channel,
  onCancel,
  onSubmit,
}: ChannelEditPanelProps): React.ReactElement {
  const { t } = useTranslation();

  const fields = useMemo(() => configFields(channel.type), [channel.type]);
  const storedSecretKeys = useMemo(
    () => new Set(fields.filter((f) => f.secret && f.key in channel.config).map((f) => f.key)),
    [fields, channel.config],
  );

  const [plain, setPlain] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of fields) if (!f.secret) init[f.key] = channel.config[f.key] ?? '';
    return init;
  });
  const [secrets, setSecrets] = useState<Record<string, SecretChange>>({});
  // channel.events is the DTO's string[]; the server only ever stores valid types.
  const [events, setEvents] = useState<NotificationEventType[]>(
    () => channel.events as NotificationEventType[],
  );
  const [sev, setSev] = useState<NotificationSeverity>(channel.minSeverity);
  const [invalidKeys, setInvalidKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const sevOptions: SelectOption[] = NOTIFICATION_SEVERITIES.map((s) => ({
    value: s,
    label: t(`settings.channels.sev.${s}`),
  }));
  const summary = eventsSummary(events);

  const toggleEvent = (ev: NotificationEventType): void =>
    setEvents((cur) => (cur.includes(ev) ? cur.filter((e) => e !== ev) : [...cur, ev]));

  const handleSave = (): void => {
    const { config, invalid } = buildConfig(channel.type, plain, secrets, storedSecretKeys);
    if (invalid.length > 0) {
      setInvalidKeys(new Set(invalid));
      setEditError(t('settings.channels.form.checkFields'));
      return;
    }
    setInvalidKeys(new Set());
    setEditError(null);
    setSaving(true);
    onSubmit({ config, events, minSeverity: sev }).catch((err: unknown) => {
      setSaving(false);
      // 404 is toasted + closed by the parent (the row unmounts). Everything else
      // that rethrows — 400 validation, a 500, a network error — surfaces inline so
      // a failed save is never silent: a server ApiError shows its (secret-free)
      // message, anything else a generic retry hint.
      setEditError(
        err instanceof ApiError ? err.message : t('settings.channels.toast.actionError'),
      );
    });
  };

  return (
    <div className="tv-set-ch__edit">
      <div className="tv-set-ch__merge">
        <Icon name="lock" size={13} />
        <span>{t('settings.channels.form.mergeHint')}</span>
      </div>

      <ChannelForm
        type={channel.type}
        plain={plain}
        onPlainChange={(key, value) => setPlain((cur) => ({ ...cur, [key]: value }))}
        onSecretChange={(key, change) => setSecrets((cur) => ({ ...cur, [key]: change }))}
        storedSecretKeys={storedSecretKeys}
        invalidKeys={invalidKeys}
        disabled={saving}
      />

      <div className="tv-set-ch__subs">
        <div className="tv-set-ch__subs-head">
          <span className="tv-set-ch__subs-label">{t('settings.channels.form.events')}</span>
          <span className="tv-set-ch__subs-summary">
            {summary.all
              ? t('settings.channels.form.allEvents')
              : t('settings.channels.form.eventsCount', {
                  count: summary.count,
                  total: NOTIFICATION_EVENT_TYPES.length,
                })}
          </span>
        </div>
        <div className="tv-set-ch__subs-body">
          <div
            className="tv-set-ch__events"
            role="group"
            aria-label={t('settings.channels.form.events')}
          >
            {NOTIFICATION_EVENT_TYPES.map((ev) => (
              <Checkbox
                key={ev}
                label={t(EVENT_LABEL_KEY[ev])}
                checked={events.includes(ev)}
                disabled={saving}
                onChange={() => toggleEvent(ev)}
              />
            ))}
          </div>
          <div className="tv-set-ch__sev">
            <Select
              label={t('settings.channels.form.minSeverity')}
              value={sev}
              options={sevOptions}
              disabled={saving}
              onChange={(v) => setSev(v as NotificationSeverity)}
            />
          </div>
        </div>
      </div>

      {editError !== null && (
        <span className="tv-set-field__error" role="alert">
          {editError}
        </span>
      )}

      <div className="tv-set-ch__editfoot">
        <Button variant="primary" size="sm" onClick={handleSave} disabled={saving}>
          {saving ? t('settings.common.saving') : t('settings.channels.form.save')}
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={saving}>
          {t('settings.channels.form.cancel')}
        </Button>
      </div>
    </div>
  );
}
