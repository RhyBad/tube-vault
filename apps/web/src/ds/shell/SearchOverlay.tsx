/**
 * SearchOverlay — the always-on global search (content typeahead, not a nav
 * palette). Debounced; groups Channels (EP-11, client-filtered — EP-11 has no
 * server search) and Videos (EP-15, limit ~8). ↑↓ move, Enter opens the
 * highlighted row (or "See all → Library" when past the list), Esc closes.
 * Desktop dropdown / mobile full-screen is a CSS concern; the behavior is shared.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import type {
  ChannelDto,
  ChannelListResponse,
  VideoListResponse,
  VideoWithChannelDto,
} from '@tubevault/types';

import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { apiGet } from '../../lib/api';
import { EmptyState } from '../feedback/EmptyState';
import '../forms/field.css';
import { Icon } from '../icon/Icon';
import { StatusBadge } from '../status/StatusBadge';
import './SearchOverlay.css';

export interface SearchOverlayProps {
  open: boolean;
  onClose: () => void;
}

interface Row {
  key: string;
  target: string;
}

export function SearchOverlay({ open, onClose }: SearchOverlayProps): React.ReactElement | null {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [channels, setChannels] = useState<ChannelDto[]>([]);
  const [videos, setVideos] = useState<VideoWithChannelDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const debounced = useDebouncedValue(query.trim(), 200);

  useEffect(() => {
    if (open) {
      // Snapshot the invoking control so focus returns to it on close — else a
      // keyboard/SR user is dumped to <body> (WCAG 2.4.3). Mirrors ConfirmDialog.
      const invoker = document.activeElement as HTMLElement | null;
      inputRef.current?.focus();
      return () => {
        if (invoker !== null && invoker.isConnected) invoker.focus();
      };
    }
    setQuery('');
    setChannels([]);
    setVideos([]);
    setActive(0);
    return undefined;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (debounced === '') {
      setChannels([]);
      setVideos([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const q = debounced.toLowerCase();
    void Promise.all([
      apiGet<ChannelListResponse>('/channels').catch(
        () => ({ channels: [] }) as ChannelListResponse,
      ),
      apiGet<VideoListResponse>(`/videos?search=${encodeURIComponent(debounced)}&limit=8`).catch(
        () => ({ videos: [], total: 0 }) as VideoListResponse,
      ),
    ]).then(([ch, vid]) => {
      if (cancelled) return;
      setChannels(
        ch.channels
          .filter(
            (c) => c.title.toLowerCase().includes(q) || (c.handle ?? '').toLowerCase().includes(q),
          )
          .slice(0, 5),
      );
      setVideos(vid.videos);
      setActive(0);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [debounced, open]);

  const rows = useMemo<Row[]>(
    () => [
      ...channels.map((c) => ({ key: `c:${c.id}`, target: `/channels/${c.id}` })),
      ...videos.map((v) => ({ key: `v:${v.id}`, target: `/videos/${v.id}` })),
    ],
    [channels, videos],
  );

  if (!open) return null;

  const go = (target: string): void => {
    navigate(target);
    onClose();
  };
  const seeAll = (): void => go(`/library?search=${encodeURIComponent(debounced)}`);

  const hasQuery = debounced !== '';
  const hasResults = rows.length > 0;
  // The "See all → Library" affordance is a virtual row just past the results,
  // so ↑↓ + Enter can reach it (the documented keyboard contract).
  const seeAllIndex = hasQuery ? rows.length : -1;
  const maxIndex = seeAllIndex >= 0 ? rows.length : rows.length - 1;

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, maxIndex));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (active < rows.length) {
        const row = rows[active];
        if (row) go(row.target);
      } else if (seeAllIndex >= 0) {
        seeAll();
      }
    }
  };

  return (
    <div className="tv-search" role="presentation" onClick={onClose}>
      <div className="tv-search__scrim" />
      <div
        className="tv-search__panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('shell.search.placeholder')}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="tv-search__header">
          {/* Mobile-only: the full-screen panel covers the scrim and touch has no
              Esc, so a leading close affordance is the only escape (Sshell-R1). */}
          <button
            type="button"
            className="tv-search__close"
            aria-label={t('shell.search.close')}
            onClick={onClose}
          >
            <Icon name="chevron-left" size={20} />
          </button>
          <div className="tv-search__inputwrap tv-field__control">
            <Icon name="search" size={18} className="tv-field__icon" />
            <input
              ref={inputRef}
              type="search"
              className="tv-input tv-input--with-icon"
              aria-label={t('shell.search.placeholder')}
              placeholder={t('shell.search.placeholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>

        <div className="tv-search__results">
          {!hasQuery ? (
            <div className="tv-search__hint">{t('shell.search.hint')}</div>
          ) : loading && !hasResults ? (
            <div className="tv-search__hint">{t('shell.search.searching')}</div>
          ) : !hasResults ? (
            <EmptyState
              variant="filtered"
              title={t('shell.search.noMatchTitle', { query: debounced })}
              description={t('shell.search.noMatchBody')}
            />
          ) : (
            <>
              {channels.length > 0 && (
                <div className="tv-search__group">
                  <div className="tv-search__grouphead">{t('shell.search.channels')}</div>
                  {channels.map((c, i) => (
                    <button
                      key={c.id}
                      type="button"
                      className={`tv-search__row${active === i ? ' tv-search__row--active' : ''}`}
                      onClick={() => go(`/channels/${c.id}`)}
                    >
                      <Icon name="channels" size={16} className="tv-search__rowicon" />
                      <span className="tv-search__rowtitle">{c.title}</span>
                      {/* ChannelDto.handle already includes the leading '@'. */}
                      {c.handle !== null && <span className="tv-search__rowmeta">{c.handle}</span>}
                    </button>
                  ))}
                </div>
              )}
              {videos.length > 0 && (
                <div className="tv-search__group">
                  <div className="tv-search__grouphead">{t('shell.search.videos')}</div>
                  {videos.map((v, i) => (
                    <button
                      key={v.id}
                      type="button"
                      className={`tv-search__row${active === channels.length + i ? ' tv-search__row--active' : ''}`}
                      onClick={() => go(`/videos/${v.id}`)}
                    >
                      <Icon name="play" size={16} className="tv-search__rowicon" />
                      <span className="tv-search__rowtitle">{v.title}</span>
                      <span className="tv-search__rowmeta">{v.channelTitle}</span>
                      <StatusBadge copyState={v.copyState} sourceState={v.sourceState} size="sm" />
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {hasQuery && (
          <button
            type="button"
            className={`tv-search__seeall${active === seeAllIndex ? ' tv-search__seeall--active' : ''}`}
            onClick={seeAll}
          >
            {t('shell.search.seeAll')}
            <Icon name="arrow-right" size={14} />
          </button>
        )}
        <div className="tv-search__keyhint">{t('shell.search.keyHint')}</div>
      </div>
    </div>
  );
}
