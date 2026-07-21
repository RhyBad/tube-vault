/**
 * App routing. The AppShell is the ONE layout for every authed destination
 * (canonical nav lives inside it); /login sits OUTSIDE the shell (pre-auth,
 * centered card). Foundation §A: each destination renders a ComingSoon stub —
 * the §B screen PRs replace these one at a time. AppRoutes is exported without a
 * Router so tests can drive it under a MemoryRouter.
 */
import { BrowserRouter, Outlet, Route, Routes, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { ErrorBoundary } from './components/ErrorBoundary';
import { AppShell } from './ds/shell/AppShell';
import { EmptyState } from './ds/feedback/EmptyState';
import { ChannelDetailPage } from './features/channel';
import { ChannelsPage } from './features/channels';
import { HomePage } from './features/home';
import { LibraryPage } from './features/library';
import { LivePage } from './features/live';
import { NotificationsPage } from './features/notifications';
import { QueuePage } from './features/queue';
import { SettingsPage } from './features/settings';
import { StoragePage } from './features/storage';
import { VideoDetailPage } from './features/video';
import { LoginPage } from './features/login';

/** Keyed by :id so a channel switch remounts the page (filters/selection reset). */
function ChannelDetailRoute(): React.ReactElement {
  const { id } = useParams();
  return <ChannelDetailPage key={id} id={id ?? ''} />;
}

/** Keyed by :id so navigating between videos remounts (resets player/state). */
function VideoDetailRoute(): React.ReactElement {
  const { id } = useParams();
  return <VideoDetailPage key={id} id={id ?? ''} />;
}

function ShellLayout(): React.ReactElement {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

export function AppRoutes(): React.ReactElement {
  const { t } = useTranslation();
  return (
    <Routes>
      {/* Pre-auth: no shell. */}
      <Route path="/login" element={<LoginPage />} />

      {/* Everything else lives in the one shell. */}
      <Route element={<ShellLayout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/queue" element={<QueuePage />} />
        <Route path="/live" element={<LivePage />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/channels" element={<ChannelsPage />} />
        <Route path="/channels/:id" element={<ChannelDetailRoute />} />
        <Route path="/storage" element={<StoragePage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/videos/:id" element={<VideoDetailRoute />} />
        <Route
          path="*"
          element={
            <EmptyState
              icon="help"
              title={t('common.notFound')}
              description={t('common.notFoundBody')}
            />
          }
        />
      </Route>
    </Routes>
  );
}

export default function App(): React.ReactElement {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </ErrorBoundary>
  );
}
