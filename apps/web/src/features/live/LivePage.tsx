/**
 * LivePage — S7, the live watch/observe screen. It OWNS the three area hooks
 * (each its own independent load/refresh/error, spec §9) + the one control this
 * screen has: the optimistic watchLive toggle (with success/failure toasts and a
 * per-row in-flight flag). Every other action is "look + go there" — a capture or
 * recording opens the video page (S5), the empty/credential affordances jump to
 * Channels / Settings. A 1 s `now` tick feeds the capture cards so their elapsed/
 * heartbeat advance smoothly, and it runs ONLY while a capture is live.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Toast, type ToastIntent } from '../../ds';
import { LiveCapturesSection } from './LiveCapturesSection';
import { RecentLivesSection } from './RecentLivesSection';
import { WatchedChannelsSection } from './WatchedChannelsSection';
import { useLiveCaptures } from './useLiveCaptures';
import { useRecentLives } from './useRecentLives';
import { useWatchedChannels } from './useWatchedChannels';
import './LivePage.css';

interface ToastItem {
  id: number;
  intent: ToastIntent;
  title: string;
}

export function LivePage(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const captures = useLiveCaptures();
  const watched = useWatchedChannels();
  const recent = useRecentLives();

  // Keep `now` honest: a 1 s tick while a capture is live (smooth elapsed/heartbeat)
  // and a slow 60 s tick otherwise so the recently-ended list's relative times don't
  // freeze — but no timer at all when there's nothing time-sensitive on screen.
  const hasLive = captures.sessions.length > 0;
  const hasRecent = recent.videos.length > 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasLive && !hasRecent) return;
    const id = setInterval(() => setNow(Date.now()), hasLive ? 1_000 : 60_000);
    return () => clearInterval(id);
  }, [hasLive, hasRecent]);

  // Toasts (auto-dismissing) for the toggle outcome.
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeq = useRef(0);
  const pushToast = useCallback((intent: ToastIntent, title: string) => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev, { id, intent, title }]);
  }, []);
  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  // watchLive toggle: optimistic in the hook; the page owns the in-flight rows +
  // the outcome toast (a paused toast reminds that the running capture continues).
  // A Set — not one id — so two channels toggled in quick succession both stay
  // disabled until each settles, instead of the second clobbering the first.
  const [togglingIds, setTogglingIds] = useState<ReadonlySet<string>>(() => new Set());
  const setWatchLive = watched.setWatchLive;
  const handleToggle = useCallback(
    (id: string, next: boolean) => {
      setTogglingIds((prev) => new Set(prev).add(id));
      setWatchLive(id, next)
        .then(() =>
          pushToast(
            next ? 'success' : 'info',
            next ? t('live.channels.watchingToast') : t('live.channels.pausedToast'),
          ),
        )
        .catch(() => pushToast('danger', t('live.channels.toggleError')))
        .finally(() =>
          setTogglingIds((prev) => {
            const nextSet = new Set(prev);
            nextSet.delete(id);
            return nextSet;
          }),
        );
    },
    [setWatchLive, pushToast, t],
  );

  const channelsRef = useRef(watched.channels);
  channelsRef.current = watched.channels;
  const onToggle = useCallback(
    (id: string) => {
      const ch = channelsRef.current.find((c) => c.id === id);
      if (ch !== undefined) handleToggle(id, !ch.watchLive);
    },
    [handleToggle],
  );

  return (
    <div className="tv-live">
      <LiveCapturesSection
        sessions={captures.sessions}
        progress={captures.progress}
        now={now}
        loading={captures.loading}
        error={captures.error}
        onRetry={captures.retry}
        onOpenVideo={(videoId) => navigate(`/videos/${videoId}`)}
        onWatchChannels={() => navigate('/channels')}
      />

      <WatchedChannelsSection
        channels={watched.channels}
        showCredentialHint={watched.showCredentialHint}
        togglingIds={togglingIds}
        loading={watched.loading}
        error={watched.error}
        onRetry={watched.retry}
        onToggle={onToggle}
        onAddChannel={() => navigate('/channels')}
        onOpenSettings={() => navigate('/settings')}
      />

      <RecentLivesSection
        videos={recent.videos}
        now={now}
        loading={recent.loading}
        error={recent.error}
        onRetry={recent.retry}
        onOpenVideo={(videoId) => navigate(`/videos/${videoId}`)}
      />

      <div className="tv-live__toasts">
        {toasts.map((tst) => (
          <Toast
            key={tst.id}
            intent={tst.intent}
            title={tst.title}
            onDismiss={() => dismissToast(tst.id)}
          />
        ))}
      </div>
    </div>
  );
}
