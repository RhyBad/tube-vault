/**
 * BellPopup — the bell's peek (the search overlay's twin). Shows the top
 * undismissed notifications (EP-27), each severity-weighted with a REMEDY-FIRST
 * target link that routes to where the operator fixes it (credential → Settings,
 * retry → Queue, view video → detail, watch live → Live, storage → Storage).
 * Inline dismiss (EP-28), "Mark all read" (EP-41), "See all → Notifications",
 * and a calm "All clear" empty. Real event types only; severity from the backend.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import type { NotificationDto, NotificationListResponse } from '@tubevault/types';

import { apiGet, apiPost } from '../../lib/api';
import { EmptyState } from '../feedback/EmptyState';
import { NotificationItem } from '../feedback/NotificationItem';
import { Button } from '../forms/Button';
import { Icon } from '../icon/Icon';
import { remedyFor } from './remedy';
import './BellPopup.css';

const PEEK_LIMIT = 6;

export interface BellPopupProps {
  open: boolean;
  onClose: () => void;
  /**
   * Fired after the peek's contents change (a dismiss or mark-all) so the shell
   * can REFETCH the authoritative unread count. The 6-item peek is a truncated
   * view, never a count — it must not drive the badge (that would shrink a "12"
   * to "6" on open). The shell owns the count via its own wider poll.
   */
  onChanged?: () => void;
}

export function BellPopup({ open, onClose, onChanged }: BellPopupProps): React.ReactElement | null {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [items, setItems] = useState<NotificationDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    apiGet<NotificationListResponse>(`/notifications?undismissed=true&limit=${PEEK_LIMIT}`)
      .then((res) => {
        if (cancelled) return;
        setItems(res.notifications);
        setLoading(false);
      })
      .catch(() => {
        // A failed fetch must NOT masquerade as the calm "All clear" (Sshell-7).
        if (!cancelled) {
          setFailed(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, reloadToken]);

  // Modal contract: focus enters the panel on open; Esc closes; focus returns to
  // the invoking trigger on close (WCAG 2.4.3 — mirrors ConfirmDialog).
  useEffect(() => {
    if (!open) return;
    const invoker = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (invoker !== null && invoker.isConnected) invoker.focus();
    };
  }, [open]);

  if (!open) return null;

  const go = (target: string): void => {
    navigate(target);
    onClose();
  };

  const dismiss = (id: string): void => {
    setItems((prev) => prev.filter((n) => n.id !== id));
    void apiPost(`/notifications/${id}/dismiss`)
      .then(() => onChangedRef.current?.())
      .catch(() => {});
  };

  const markAll = (): void => {
    setItems([]);
    void apiPost('/notifications/dismiss-all')
      .then(() => onChangedRef.current?.())
      .catch(() => {});
  };

  const retry = (): void => setReloadToken((n) => n + 1);

  const empty = !loading && !failed && items.length === 0;

  return (
    <div className="tv-bell" role="presentation" onClick={onClose}>
      <div className="tv-bell__scrim" />
      <div
        ref={panelRef}
        className="tv-bell__panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('shell.bell.title')}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tv-bell__head">
          {/* Mobile-only: the full-screen popup covers the scrim and touch has no
              Esc, so a leading close affordance is the only escape (Sshell-R1). */}
          <button
            type="button"
            className="tv-bell__close"
            aria-label={t('shell.bell.close')}
            onClick={onClose}
          >
            <Icon name="chevron-left" size={20} />
          </button>
          <h2 className="tv-bell__title">{t('shell.bell.title')}</h2>
          {!failed && items.length > 0 && (
            <Button size="sm" variant="ghost" icon="mark-all-read" onClick={markAll}>
              {t('shell.bell.markAllRead')}
            </Button>
          )}
        </div>
        <div className="tv-bell__list">
          {failed ? (
            <EmptyState
              icon="alert"
              title={t('shell.bell.errorTitle')}
              description={t('shell.bell.errorBody')}
              action={
                <Button size="sm" variant="secondary" icon="retry" onClick={retry}>
                  {t('shell.bell.retryLoad')}
                </Button>
              }
            />
          ) : empty ? (
            <EmptyState
              icon="shield-check"
              title={t('shell.bell.emptyTitle')}
              description={t('shell.bell.emptyBody')}
            />
          ) : (
            items.map((n) => {
              const remedy = remedyFor(n);
              return (
                <NotificationItem
                  key={n.id}
                  severity={n.severity}
                  tone={n.type === 'video.rescued' ? 'rescue' : 'severity'}
                  title={n.title}
                  body={n.body}
                  timestamp={n.createdAt}
                  unread={n.dismissedAt === null}
                  targetLabel={remedy !== null ? t(remedy.labelKey) : undefined}
                  onTargetClick={remedy !== null ? () => go(remedy.target) : undefined}
                  onDismiss={() => dismiss(n.id)}
                />
              );
            })
          )}
        </div>
        <button type="button" className="tv-bell__seeall" onClick={() => go('/notifications')}>
          {t('shell.bell.seeAll')}
          <Icon name="arrow-right" size={14} />
        </button>
      </div>
    </div>
  );
}
