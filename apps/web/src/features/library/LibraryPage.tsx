/**
 * LibraryPage — S4. A THIN cross-channel browse screen: it reuses the shared
 * useVideosBrowser (bound to EP-15 getVideos) + VideosBrowser verbatim, adding
 * only the pieces the library owns:
 *
 *  - a page header (eyebrow + title + subtitle),
 *  - the grid/list view toggle (views prop; grid is the default),
 *  - the cross-channel channel filter (EP-11) dropped into the More-filters drawer
 *    and wired to browser.setChannelId,
 *  - the nothing-preserved empty copy (distinct from the filtered-zero empty),
 *  - a Toast queue + the EP-19 enqueue verdict (download-N-selected only — there
 *    is no per-channel "back up all" here; that lives on S3).
 *
 * A `?search=` URL param seeds the search box once on mount (the future global
 * "See all → Library" hand-off). Realtime badge patching + reconnect refetch are
 * the hook's concern (video.changed / reconnected), inherited unchanged.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';

import type { EnqueueRequest, VideoDto } from '@tubevault/types';

import { Toast, type ToastIntent } from '../../ds';
import { ApiError } from '../../lib/api';
import { getVideos, enqueueVideos } from '../videos/videos-api';
import { useVideosBrowser } from '../videos/useVideosBrowser';
import { VideosBrowser } from '../videos/VideosBrowser';
import { ChannelFilter } from './ChannelFilter';
import './LibraryPage.css';

const LIBRARY_VIEWS = ['grid', 'list'] as const;

interface ToastItem {
  id: number;
  intent: ToastIntent;
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function LibraryPage(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const browser = useVideosBrowser<VideoDto>({ fetchPage: getVideos });

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeq = useRef(0);
  const pushToast = useCallback((toast: Omit<ToastItem, 'id'>) => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev, { ...toast, id }]);
  }, []);
  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  // Seed the search box from ?search= once on mount (global-search hand-off).
  const seeded = useRef(false);
  const setSearch = browser.setSearch;
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    const q = searchParams.get('search');
    if (q !== null && q !== '') setSearch(q);
  }, [searchParams, setSearch]);

  // ── acquire (EP-19 — download-N-selected only) ──────────────────────────────
  const runEnqueue = useCallback(
    async (body: EnqueueRequest, onDone?: () => void) => {
      try {
        const res = await enqueueVideos(body);
        if (res.enqueued.length > 0) {
          pushToast({
            intent: 'success',
            title: t('library.toast.queuedTitle', { count: res.enqueued.length }),
            message: t('library.toast.queuedBody'),
          });
        } else if (res.skipped.length > 0) {
          pushToast({
            intent: 'info',
            title: t('library.toast.nothingTitle'),
            message: t('library.toast.skippedBody'),
          });
        } else {
          pushToast({
            intent: 'info',
            title: t('library.toast.nothingTitle'),
            message: t('library.toast.nothingBody'),
          });
        }
        onDone?.();
      } catch (err) {
        if (err instanceof ApiError && err.status === 503) {
          pushToast({
            intent: 'warning',
            title: t('library.toast.full'),
            message: t('library.toast.fullBody'),
            actionLabel: t('library.toast.retry'),
            onAction: () => void runEnqueue(body, onDone),
          });
        } else {
          pushToast({
            intent: 'danger',
            title: t('library.toast.badRequest'),
            message: t('library.toast.badRequestBody'),
          });
        }
      }
    },
    [pushToast, t],
  );

  const onDownloadSelected = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      void runEnqueue({ videoIds: ids }, browser.clearSelection);
    },
    [runEnqueue, browser.clearSelection],
  );

  return (
    <div className="tv-lib">
      <header className="tv-lib__head">
        <span className="tv-lib__eyebrow">{t('library.eyebrow')}</span>
        <h1 className="tv-lib__title">{t('library.title')}</h1>
        <p className="tv-lib__subtitle">{t('library.subtitle')}</p>
      </header>

      <VideosBrowser
        browser={browser}
        searchPlaceholder={t('videos.searchLibrary')}
        onOpenVideo={(id) => navigate(`/videos/${id}`)}
        onDownloadSelected={onDownloadSelected}
        views={LIBRARY_VIEWS}
        emptyTitle={t('videos.empty.libraryTitle')}
        emptyDescription={t('videos.empty.libraryBody')}
        channelFilter={<ChannelFilter value={browser.channelId} onChange={browser.setChannelId} />}
      />

      <div className="tv-lib__toasts">
        {toasts.map((tst) => (
          <Toast
            key={tst.id}
            intent={tst.intent}
            title={tst.title}
            message={tst.message}
            actionLabel={tst.actionLabel}
            onAction={
              tst.onAction
                ? () => {
                    tst.onAction?.();
                    dismissToast(tst.id);
                  }
                : undefined
            }
            onDismiss={() => dismissToast(tst.id)}
          />
        ))}
      </div>
    </div>
  );
}
