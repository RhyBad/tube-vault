/**
 * ChannelsPage — S2. The channel list is ONE backend (useChannels), so the page
 * owns the cross-cutting concerns: the toast queue, the destructive-action
 * confirm dialog (soft unregister = a calm confirm; hard purge = danger +
 * type-to-confirm the @handle), and navigation (a card opens S3; the register
 * notice links jump to the queue/home). The register widget owns its own inline
 * feedback; the row actions toast. An ENUMERATE job finishing toasts "counts
 * updated" (the hook already cleared that row's spinner + refetched).
 */
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import type { ChannelDto } from '@tubevault/types';

import { ConfirmDialog, Toast, type ToastIntent } from '../../ds';
import { activeCount } from './channels-presentation';
import { ChannelsList } from './ChannelsList';
import { RegisterPanel } from './RegisterPanel';
import { useChannels } from './useChannels';
import './ChannelsPage.css';

interface ToastItem {
  id: number;
  intent: ToastIntent;
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
}

/** The pending destructive action awaiting confirmation. */
type PendingConfirm = { mode: 'unregister' | 'purge'; channel: ChannelDto } | null;

export function ChannelsPage(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();

  // ---- toasts (auto-dismissing) ----
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeq = useRef(0);
  const pushToast = useCallback(
    (
      intent: ToastIntent,
      title: string,
      message?: string,
      action?: { label: string; onAction: () => void },
    ) => {
      const id = ++toastSeq.current;
      setToasts((prev) => [
        ...prev,
        { id, intent, title, message, actionLabel: action?.label, onAction: action?.onAction },
      ]);
    },
    [],
  );
  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  // An ENUMERATE job finishing → a "counts updated" toast (the hook cleared the
  // spinner + refetched). The channels list is read live inside the callback.
  const channelsRef = useRef<ChannelDto[]>([]);
  const onEnumerateComplete = useCallback(
    (channelId: string) => {
      const c = channelsRef.current.find((x) => x.id === channelId);
      pushToast(
        'info',
        t('channels.toast.enumDoneTitle'),
        t('channels.toast.enumDoneMsg', {
          name: c?.title ?? channelId,
        }),
      );
    },
    [pushToast, t],
  );

  const ch = useChannels(onEnumerateComplete);
  channelsRef.current = ch.channels;

  const find = useCallback(
    (id: string): ChannelDto | undefined => ch.channels.find((c) => c.id === id),
    [ch.channels],
  );

  // ---- register field focus (the empty-state action jumps here) ----
  const registerRef = useRef<HTMLDivElement>(null);
  const focusRegister = useCallback(() => {
    registerRef.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, []);

  // ---- row actions ----
  const onToggleWatch = useCallback(
    (id: string) => {
      const c = find(id);
      if (c === undefined) return;
      const next = !c.watchLive;
      ch.setWatchLive(id, next)
        .then(() =>
          pushToast(
            'info',
            t(next ? 'channels.toast.liveOnTitle' : 'channels.toast.liveOffTitle'),
            t(next ? 'channels.toast.liveOnMsg' : 'channels.toast.liveOffMsg', { name: c.title }),
          ),
        )
        .catch(() => pushToast('danger', t('channels.toast.actionError')));
    },
    [ch, find, pushToast, t],
  );

  const onReactivate = useCallback(
    (id: string) => {
      const c = find(id);
      ch.reactivate(id)
        .then(() =>
          // Re-enumerates in the background → offer the same queue shortcut as register.
          pushToast(
            'success',
            t('channels.toast.reactTitle'),
            t('channels.toast.reactMsg', { name: c?.title ?? id }),
            { label: t('channels.register.viewQueue'), onAction: () => navigate('/queue') },
          ),
        )
        .catch(() => pushToast('danger', t('channels.toast.actionError')));
    },
    [ch, find, pushToast, navigate, t],
  );

  // ---- confirm (unregister / purge) ----
  const [confirm, setConfirm] = useState<PendingConfirm>(null);
  const closeConfirm = useCallback(() => setConfirm(null), []);

  const requestUnregister = useCallback(
    (id: string) => {
      const channel = find(id);
      if (channel !== undefined) setConfirm({ mode: 'unregister', channel });
    },
    [find],
  );
  const requestPurge = useCallback(
    (id: string) => {
      const channel = find(id);
      if (channel !== undefined) setConfirm({ mode: 'purge', channel });
    },
    [find],
  );

  const doConfirm = useCallback(() => {
    if (confirm === null) return;
    const { mode, channel } = confirm;
    setConfirm(null);
    if (mode === 'unregister') {
      ch.unregister(channel.id)
        .then(() =>
          pushToast(
            'info',
            t('channels.toast.unregTitle'),
            t('channels.toast.unregMsg', { name: channel.title }),
          ),
        )
        .catch(() => pushToast('danger', t('channels.toast.actionError')));
    } else {
      ch.purge(channel.id)
        .then(() =>
          pushToast(
            'danger',
            t('channels.toast.purgeTitle'),
            t('channels.toast.purgeMsg', { name: channel.title }),
          ),
        )
        .catch(() => pushToast('danger', t('channels.toast.actionError')));
    }
  }, [confirm, ch, pushToast, t]);

  const confirmProps =
    confirm === null
      ? null
      : confirm.mode === 'unregister'
        ? {
            title: t('channels.confirm.unregTitle', { name: confirm.channel.title }),
            description: t('channels.confirm.unregDesc'),
            confirmLabel: t('channels.confirm.unregConfirm'),
            danger: false,
            requireText: undefined,
          }
        : {
            title: t('channels.confirm.purgeTitle', { name: confirm.channel.title }),
            description: t('channels.confirm.purgeDesc', { n: confirm.channel.videoCounts.total }),
            confirmLabel: t('channels.confirm.purgeConfirm'),
            danger: true,
            // Type-to-confirm the @handle (falls back to a stable literal).
            requireText: confirm.channel.handle ?? '@channel',
          };

  return (
    <div className="tv-ch">
      <header className="tv-ch__page-head">
        <h1 className="tv-ch__page-title">{t('channels.page.title')}</h1>
        <p className="tv-ch__subtitle">{t('channels.page.subtitle')}</p>
        {!ch.loading && ch.channels.length > 0 && (
          <span className="tv-ch__count tv-numeric">
            {t('channels.page.count', {
              count: ch.channels.length,
              active: activeCount(ch.channels),
            })}
          </span>
        )}
      </header>

      <div ref={registerRef}>
        <RegisterPanel
          onRegister={ch.register}
          onNavigate={(dest) => navigate(dest === 'queue' ? '/queue' : '/')}
        />
      </div>

      <ChannelsList
        loading={ch.loading}
        error={ch.error}
        channels={ch.channels}
        enumerating={ch.enumerating}
        onRetry={ch.retry}
        onOpen={(id) => navigate(`/channels/${encodeURIComponent(id)}`)}
        onToggleWatch={onToggleWatch}
        onUnregister={requestUnregister}
        onReactivate={onReactivate}
        onPurge={requestPurge}
        onRegisterFirst={focusRegister}
      />

      {confirmProps !== null && (
        <ConfirmDialog
          open
          title={confirmProps.title}
          description={confirmProps.description}
          confirmLabel={confirmProps.confirmLabel}
          danger={confirmProps.danger}
          requireText={confirmProps.requireText}
          onConfirm={doConfirm}
          onCancel={closeConfirm}
        />
      )}

      <div className="tv-ch__toasts">
        {toasts.map((tst) => (
          <Toast
            key={tst.id}
            intent={tst.intent}
            title={tst.title}
            message={tst.message}
            actionLabel={tst.actionLabel}
            onAction={tst.onAction}
            onDismiss={() => dismissToast(tst.id)}
          />
        ))}
      </div>
    </div>
  );
}
