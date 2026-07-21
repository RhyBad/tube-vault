/**
 * NotificationChannelsSection — Section 2's view (EP-29..33). Orchestrates the
 * channel rows, the add panel, and the empty state; owns the transient UI state
 * (which row is editing, whether the add panel is open). Mutations flow through
 * the hook (which refetches); this section maps outcomes to the page's toasts and
 * routes deletes to the page's confirm dialog. delivered:false test results are
 * neutral (rendered inline by the row), never a toast.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  CreateNotificationChannelRequest,
  NotificationChannelDto,
  UpdateNotificationChannelRequest,
} from '@tubevault/types';

import { ApiError } from '../../lib/api';
import { Button, EmptyState, type ToastIntent } from '../../ds';
import { ChannelAddPanel } from './ChannelAddPanel';
import { NotificationChannelRow } from './NotificationChannelRow';
import { SettingsSectionCard } from './SettingsSectionCard';
import type { UseNotificationChannelsResult } from './useNotificationChannels';

export interface NotificationChannelsSectionProps {
  index: number;
  channels: UseNotificationChannelsResult;
  onToast: (intent: ToastIntent, title: string, message?: string) => void;
  onRequestDelete: (channel: NotificationChannelDto) => void;
}

export function NotificationChannelsSection({
  index,
  channels,
  onToast,
  onRequestDelete,
}: NotificationChannelsSectionProps): React.ReactElement {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const list = channels.channels;
  const isEmpty = list.length === 0;

  const notFoundToast = (): void =>
    onToast(
      'danger',
      t('settings.channels.toast.notFoundTitle'),
      t('settings.channels.toast.notFoundDesc'),
    );

  const startEdit = (id: string): void => {
    setEditingId(id);
    setAddOpen(false);
    channels.clearResult(id);
  };

  const submitEdit =
    (id: string) =>
    (body: UpdateNotificationChannelRequest): Promise<void> =>
      channels
        .update(id, body)
        .then(() => {
          onToast('success', t('settings.channels.toast.updated'));
          setEditingId(null);
        })
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 404) {
            notFoundToast();
            setEditingId(null);
            return; // handled — the row is already gone
          }
          throw err; // 400 → the edit panel shows it inline
        });

  const submitAdd = (body: CreateNotificationChannelRequest): Promise<void> =>
    channels.create(body).then(() => {
      onToast(
        'success',
        t('settings.channels.toast.created'),
        t('settings.channels.toast.createdMsg'),
      );
      setAddOpen(false);
    });
  // create's errors (400) propagate to the add panel's inline handler.

  const handleToggle = (id: string, enabled: boolean): void => {
    channels.toggleEnabled(id, enabled).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) notFoundToast();
      else onToast('danger', t('settings.channels.toast.actionError'));
    });
  };

  const handleTest = (id: string): void => {
    channels.runTest(id).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) notFoundToast();
      else onToast('danger', t('settings.channels.toast.actionError'));
    });
  };

  return (
    <SettingsSectionCard
      index={index}
      eyebrow={t('settings.channels.eyebrow')}
      title={t('settings.channels.title')}
      description={t('settings.channels.desc')}
      epLabel={t('settings.channels.ep')}
      phase={channels.phase}
      onRetry={channels.retry}
    >
      <div className="tv-set-ch">
        {isEmpty && !addOpen && (
          <EmptyState
            icon="bell"
            title={t('settings.channels.empty.title')}
            description={t('settings.channels.empty.desc')}
            action={
              <Button variant="primary" size="sm" icon="plus" onClick={() => setAddOpen(true)}>
                {t('settings.channels.add')}
              </Button>
            }
          />
        )}

        {list.map((channel) => (
          <NotificationChannelRow
            key={channel.id}
            channel={channel}
            isEditing={editingId === channel.id}
            testing={channels.testing.has(channel.id)}
            result={channels.results[channel.id]}
            onToggleEnabled={(enabled) => handleToggle(channel.id, enabled)}
            onTest={() => handleTest(channel.id)}
            onStartEdit={() => startEdit(channel.id)}
            onCancelEdit={() => setEditingId(null)}
            onSubmitEdit={submitEdit(channel.id)}
            onDelete={() => onRequestDelete(channel)}
          />
        ))}

        {addOpen ? (
          <ChannelAddPanel onCancel={() => setAddOpen(false)} onSubmit={submitAdd} />
        ) : (
          !isEmpty && (
            <div className="tv-set-ch__addbtn">
              <Button variant="secondary" size="sm" icon="plus" onClick={() => setAddOpen(true)}>
                {t('settings.channels.add')}
              </Button>
            </div>
          )
        )}
      </div>
    </SettingsSectionCard>
  );
}
