/**
 * JobEventLog — the row drill-down (EP-26). Deliberately a SNAPSHOT, not SSE: the
 * one live stream is the global /api/events; this fetches the job's accumulated
 * JobEvent trail once (max 1000, ascending) with a manual refresh — the place an
 * operator traces WHY a download failed (WARN unresumable-restart / ERROR redacted
 * stderr tail). Loading / empty / error each have their own calm state.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { JobEventDto, LogLevel } from '@tubevault/types';

import { Icon, IconButton, Skeleton } from '../../ds';
import { formatRelativeTime } from '../../i18n/format';
import { getJobEvents } from './queue-api';
import './JobEventLog.css';

type LoadState = 'loading' | 'ready' | 'error';

const LEVEL_INTENT: Record<LogLevel, string> = {
  DEBUG: 'neutral',
  INFO: 'neutral',
  WARN: 'warning',
  ERROR: 'danger',
};

export interface JobEventLogProps {
  jobId: string;
}

export function JobEventLog({ jobId }: JobEventLogProps): React.ReactElement {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<LoadState>('loading');
  const [events, setEvents] = useState<JobEventDto[]>([]);

  const load = useCallback(() => {
    let cancelled = false;
    setState('loading');
    getJobEvents(jobId)
      .then((res) => {
        if (cancelled) return;
        setEvents(res.events);
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  useEffect(() => load(), [load]);

  return (
    <section className="tv-joblog" aria-label={t('queue.log.title')}>
      <header className="tv-joblog__head">
        <div className="tv-joblog__heading">
          <span className="tv-joblog__title">{t('queue.log.title')}</span>
          <span className="tv-joblog__jobid">{t('queue.log.job', { id: jobId })}</span>
        </div>
        <IconButton
          size="sm"
          variant="ghost"
          label={t('queue.log.refresh')}
          disabled={state === 'loading'}
          onClick={load}
        >
          <Icon name="retry" size={14} />
        </IconButton>
      </header>

      {state === 'loading' ? (
        <div className="tv-joblog__loading">
          <Skeleton height={14} />
          <Skeleton height={14} width="80%" />
          <Skeleton height={14} width="60%" />
        </div>
      ) : state === 'error' ? (
        <p className="tv-joblog__error">
          <Icon name="alert" size={14} />
          <span>{t('queue.log.error')}</span>
        </p>
      ) : events.length === 0 ? (
        <p className="tv-joblog__empty">{t('queue.log.empty')}</p>
      ) : (
        <ol className="tv-joblog__list">
          {events.map((e) => (
            <li key={e.id} className="tv-joblog__item">
              <span className="tv-joblog__level" data-intent={LEVEL_INTENT[e.level] ?? 'neutral'}>
                {e.level}
              </span>
              <span className="tv-joblog__msg">{e.message}</span>
              <time className="tv-joblog__time" dateTime={e.createdAt}>
                {formatRelativeTime(e.createdAt, i18n.language)}
              </time>
            </li>
          ))}
        </ol>
      )}

      {/* §S6-8: this trail is a one-shot snapshot, not the live SSE — say so. */}
      {state === 'ready' && events.length > 0 && (
        <footer className="tv-joblog__foot">
          {t('queue.log.snapshot', { count: events.length })}
        </footer>
      )}
    </section>
  );
}
