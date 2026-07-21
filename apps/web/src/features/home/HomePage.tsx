/**
 * HomePage — S1, the read-only overview landing. It OWNS the four widget hooks
 * (each its own independent load/refresh/error, spec §8) and the routing: every
 * widget action is "look + go there" (S6/S7/S-ST/S4/S5/S3/S2), never a control.
 * The one bit of shared state is a 1 s `now` tick fed to W1's live card so its
 * elapsed/heartbeat advance smoothly — and it only runs while a capture is live,
 * so an idle Home holds no timers.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { ChannelsWidget } from './ChannelsWidget';
import { NowRunningWidget } from './NowRunningWidget';
import { RecentFeedWidget } from './RecentFeedWidget';
import { StorageWidget } from './StorageWidget';
import { useChannelsOverview } from './useChannelsOverview';
import { useNowRunning } from './useNowRunning';
import { useRecentFeed } from './useRecentFeed';
import { useStorageOverview } from './useStorageOverview';
import './HomePage.css';

export function HomePage(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const nowRunning = useNowRunning();
  const storage = useStorageOverview();
  const recent = useRecentFeed();
  const channels = useChannelsOverview();

  // Smooth elapsed/heartbeat for the live card — only while a capture is active.
  const hasLive = nowRunning.live.length > 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasLive) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [hasLive]);

  return (
    <div className="tv-home">
      <header className="tv-home__header">
        <span className="tv-home__eyebrow">{t('home.eyebrow')}</span>
        <h1 className="tv-home__title">{t('home.title')}</h1>
        <p className="tv-home__subtitle">{t('home.subtitle')}</p>
      </header>

      <div className="tv-home__dash">
        <div className="tv-home__col-main">
          <NowRunningWidget
            loading={nowRunning.loading}
            error={nowRunning.error}
            items={nowRunning.items}
            capped={nowRunning.capped}
            live={nowRunning.live}
            now={now}
            onRetry={nowRunning.retry}
            onOpenQueue={() => navigate('/queue')}
            onOpenLive={() => navigate('/live')}
            onBrowseLibrary={() => navigate('/library')}
          />
          <RecentFeedWidget
            loading={recent.loading}
            error={recent.error}
            videos={recent.videos}
            onRetry={recent.retry}
            onOpenLibrary={() => navigate('/library')}
            onOpenVideo={(id) => navigate(`/videos/${id}`)}
            onAddChannel={() => navigate('/channels')}
          />
        </div>

        <div className="tv-home__col-rail">
          <StorageWidget
            loading={storage.loading}
            error={storage.error}
            vault={storage.vault}
            channels={storage.channels}
            archiveUsedBytes={storage.archiveUsedBytes}
            onRetry={storage.retry}
            onOpenStorage={() => navigate('/storage')}
            onAddChannel={() => navigate('/channels')}
          />
          <ChannelsWidget
            loading={channels.loading}
            error={channels.error}
            channels={channels.channels}
            onRetry={channels.retry}
            onOpenChannels={() => navigate('/channels')}
            onOpenChannel={(id) => navigate(`/channels/${id}`)}
            onAddChannel={() => navigate('/channels')}
          />
        </div>
      </div>
    </div>
  );
}
