/**
 * SettingsPage — S9, the settings hub. It composes THREE independent backends
 * (spec §1) — there is no aggregate endpoint — so it owns one hook per section
 * (each with its own load/save/error) plus the two cross-cutting concerns the
 * page level owns: the toast queue and the destructive-action confirm dialog
 * (delete channel / delete credential). Everything else lives in the sections.
 * No SSE (spec §7) — save → refetch. The credential cross-link jumps to S7 Live.
 *
 * A fourth section, SessionSection (Decision 1), sits at the bottom — it is
 * NOT a backend (there is no session-status GET endpoint), just the client-
 * derived expiry readout + a Sign out affordance. The page owns navigation for
 * it too: signOut() always clears the local login-time record, then the page
 * navigates to /login regardless of whether the network call itself succeeded.
 */
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import type { NotificationChannelDto } from '@tubevault/types';

import { ApiError } from '../../lib/api';
import { signOut } from '../../lib/session';
import { ConfirmDialog, Icon, Toast, type ToastIntent } from '../../ds';
import { CredentialSection } from './CredentialSection';
import { GlobalDefaultsSection } from './GlobalDefaultsSection';
import { NotificationChannelsSection } from './NotificationChannelsSection';
import { SessionSection } from './SessionSection';
import { useCredential } from './useCredential';
import { useGlobalDefaults } from './useGlobalDefaults';
import { useNotificationChannels } from './useNotificationChannels';
import './SettingsPage.css';

interface ToastItem {
  id: number;
  intent: ToastIntent;
  title: string;
  message?: string;
}

/** The pending destructive action awaiting confirmation. */
type PendingConfirm =
  { kind: 'channel'; channel: NotificationChannelDto } | { kind: 'credential' } | null;

export function SettingsPage(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const defaults = useGlobalDefaults();
  const channels = useNotificationChannels();
  const credential = useCredential();

  // ---- toasts (auto-dismissing) ----
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeq = useRef(0);
  const pushToast = useCallback((intent: ToastIntent, title: string, message?: string) => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev, { id, intent, title, message }]);
  }, []);
  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  // ---- confirm dialog (delete channel / delete credential) ----
  const [confirm, setConfirm] = useState<PendingConfirm>(null);
  const closeConfirm = useCallback(() => setConfirm(null), []);

  const doConfirm = useCallback(() => {
    if (confirm === null) return;
    if (confirm.kind === 'channel') {
      const { channel } = confirm;
      setConfirm(null);
      channels
        .remove(channel.id)
        .then(() => pushToast('success', t('settings.channels.toast.deleted')))
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 404) {
            pushToast(
              'danger',
              t('settings.channels.toast.notFoundTitle'),
              t('settings.channels.toast.notFoundDesc'),
            );
          } else {
            pushToast('danger', t('settings.channels.toast.actionError'));
          }
        });
    } else {
      setConfirm(null);
      credential
        .remove()
        .then(() => pushToast('success', t('settings.cred.toast.deleted')))
        .catch(() => pushToast('danger', t('feedback.error.title')));
    }
  }, [confirm, channels, credential, pushToast, t]);

  // Sign out lives here, not the top bar (Decision 1) — the page owns nav,
  // matching onGoLive above. signOut() always clears the local login-time
  // record even on a network error; navigation proceeds regardless. The
  // trailing catch is a no-op — signOut()'s promise can still REJECT after its
  // own .finally() runs (a network failure), and nothing downstream awaits this
  // call, so an uncaught rejection would otherwise surface as a global error.
  const handleSignOut = useCallback(() => {
    void signOut()
      .finally(() => navigate('/login'))
      .catch(() => {});
  }, [navigate]);

  const confirmCopy =
    confirm?.kind === 'channel'
      ? {
          title: t('settings.channels.del.title'),
          description: t('settings.channels.del.desc', { name: confirm.channel.name }),
          confirmLabel: t('settings.channels.del.confirm'),
        }
      : {
          title: t('settings.cred.del.title'),
          description: t('settings.cred.del.desc'),
          confirmLabel: t('settings.cred.del.confirm'),
        };

  return (
    <div className="tv-set">
      <header className="tv-set__page-head">
        <span className="tv-set__kicker">{t('settings.page.kicker')}</span>
        <h1 className="tv-set__page-title">{t('settings.page.title')}</h1>
        <p className="tv-set__subtitle">{t('settings.page.subtitle')}</p>
        <div className="tv-set__indep">
          <Icon name="server" size={14} aria-hidden />
          <span>{t('settings.page.indepNote')}</span>
        </div>
      </header>

      <GlobalDefaultsSection index={1} defaults={defaults} />

      <NotificationChannelsSection
        index={2}
        channels={channels}
        onToast={pushToast}
        onRequestDelete={(channel) => setConfirm({ kind: 'channel', channel })}
      />

      <CredentialSection
        index={3}
        credential={credential}
        onToast={pushToast}
        onRequestDelete={() => setConfirm({ kind: 'credential' })}
        onGoLive={() => navigate('/live')}
      />

      <SessionSection onSignOut={handleSignOut} />

      <ConfirmDialog
        open={confirm !== null}
        title={confirmCopy.title}
        description={confirmCopy.description}
        confirmLabel={confirmCopy.confirmLabel}
        danger
        onConfirm={doConfirm}
        onCancel={closeConfirm}
      />

      <div className="tv-set__toasts">
        {toasts.map((tst) => (
          <Toast
            key={tst.id}
            intent={tst.intent}
            title={tst.title}
            message={tst.message}
            onDismiss={() => dismissToast(tst.id)}
          />
        ))}
      </div>
    </div>
  );
}
