/**
 * NotificationChannelRow — one channel: the type chip, name, enabled state, and
 * the per-row actions (enabled toggle · real test send · edit · delete). The test
 * result renders inline and is NEUTRAL — a delivered:false shows the secret-free
 * detail, never an error. The edit form lives in ChannelEditPanel (mounts only
 * while editing so its draft is always fresh).
 */
import { useTranslation } from 'react-i18next';

import type { NotificationChannelDto, UpdateNotificationChannelRequest } from '@tubevault/types';

import { Button, Checkbox, Icon } from '../../ds';
import { ChannelEditPanel } from './ChannelEditPanel';
import type { TestResultView } from './settings-presentation';

export interface NotificationChannelRowProps {
  channel: NotificationChannelDto;
  isEditing: boolean;
  testing: boolean;
  result?: TestResultView;
  onToggleEnabled: (enabled: boolean) => void;
  onTest: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (body: UpdateNotificationChannelRequest) => Promise<void>;
  onDelete: () => void;
}

export function NotificationChannelRow({
  channel,
  isEditing,
  testing,
  result,
  onToggleEnabled,
  onTest,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onDelete,
}: NotificationChannelRowProps): React.ReactElement {
  const { t } = useTranslation();

  return (
    <div className="tv-set-ch__row">
      <div className="tv-set-ch__rowhead">
        <span className="tv-set-ch__type">{channel.type}</span>
        <span className="tv-set-ch__name" title={channel.name}>
          {channel.name}
        </span>
        <span className="tv-set-ch__state">
          <span className="tv-set-ch__dot" data-on={channel.enabled} aria-hidden="true" />
          {channel.enabled
            ? t('settings.channels.row.active')
            : t('settings.channels.row.inactive')}
        </span>

        <span className="tv-set-ch__spacer" />

        <div className="tv-set-ch__actions">
          <Checkbox
            label={t('settings.channels.row.enabled')}
            checked={channel.enabled}
            onChange={onToggleEnabled}
          />
          <Button variant="secondary" size="sm" onClick={onTest} disabled={testing}>
            {testing ? t('settings.channels.row.sending') : t('settings.channels.row.test')}
          </Button>
          <Button
            variant={isEditing ? 'primary' : 'ghost'}
            size="sm"
            onClick={isEditing ? onCancelEdit : onStartEdit}
          >
            {isEditing ? t('settings.channels.row.editing') : t('settings.channels.row.edit')}
          </Button>
          <Button variant="danger-outline" size="sm" icon="trash" onClick={onDelete}>
            {t('settings.channels.row.delete')}
          </Button>
        </div>
      </div>

      {result !== undefined && !isEditing && (
        <div className="tv-set-ch__result" data-intent={result.intent} role="status">
          <Icon name={result.ok ? 'check' : 'alert'} size={15} className="tv-set-ch__result-icon" />
          <div className="tv-set-ch__result-body">
            <span className="tv-set-ch__result-title">
              {result.ok
                ? t('settings.channels.test.delivered')
                : t('settings.channels.test.notDelivered')}
              {' · '}
              {result.detail}
            </span>
            <span className="tv-set-ch__result-note">{t('settings.channels.test.realNote')}</span>
          </div>
        </div>
      )}

      {isEditing && (
        <ChannelEditPanel channel={channel} onCancel={onCancelEdit} onSubmit={onSubmitEdit} />
      )}
    </div>
  );
}
