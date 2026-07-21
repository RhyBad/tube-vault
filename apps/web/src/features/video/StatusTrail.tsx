/**
 * StatusTrail — the audit log of every COPY / SOURCE transition, oldest first
 * (EP-16 `events` arrives ascending), rendered as "how this copy got here": the
 * download→verify→HEALTHY path, the rescue-detection moment, and any failure /
 * retry history — the raw material of trust (§6). Shown as a full-width connected-
 * dot vertical timeline (S5-L3): each event is a dot on a rail joined to the next,
 * with its axis label, from→to chips, an optional rescue badge, the note, and the
 * relative time. The row where the original went away while our copy stayed HEALTHY
 * wears the signature rescue highlight. From/to chips reuse the shared status labels
 * so they can never drift.
 */
import { useTranslation } from 'react-i18next';

import type { CopyState, SourceState, StatusAxis, VideoStatusEventDto } from '@tubevault/types';

import { Icon } from '../../ds';
import { formatRelativeTime } from '../../i18n/format';
import { isRescueEvent } from './video-presentation';

export interface StatusTrailProps {
  events: VideoStatusEventDto[];
  copyState: CopyState;
}

export function StatusTrail({ events, copyState }: StatusTrailProps): React.ReactElement {
  const { t, i18n } = useTranslation();

  // from/to are plain strings on the DTO; cast to the enum so the shared status
  // label key resolves to a finite literal union (a valid t() key).
  const label = (axis: StatusAxis, value: string): string | null => {
    if (value === '') return null;
    return axis === 'COPY'
      ? t(`status.copy.${value as CopyState}`)
      : t(`status.source.${value as SourceState}`);
  };

  return (
    <section className="tv-video__trail" aria-label={t('video.trail.title')}>
      <div className="tv-video__trail-head">
        <h2 className="tv-video__section-title">{t('video.trail.title')}</h2>
        <p className="tv-video__trail-intro">{t('video.trail.intro')}</p>
      </div>
      {events.length === 0 ? (
        <p className="tv-video__trail-empty">{t('video.trail.empty')}</p>
      ) : (
        <ol className="tv-video__trail-list">
          {events.map((ev, i) => {
            const rescue = isRescueEvent(ev.axis, ev.to, copyState);
            const from = label(ev.axis, ev.from);
            const to = label(ev.axis, ev.to);
            const isLast = i === events.length - 1;
            return (
              <li
                className="tv-video__trail-row"
                data-rescue={rescue ? 'true' : undefined}
                key={`${ev.at}-${i}`}
              >
                <div className="tv-video__trail-rail" aria-hidden="true">
                  <span
                    className="tv-video__trail-dot"
                    data-axis={ev.axis}
                    data-rescue={rescue ? 'true' : undefined}
                  />
                  {!isLast && <span className="tv-video__trail-connector" />}
                </div>
                <div className="tv-video__trail-content">
                  <div className="tv-video__trail-transition">
                    <span className="tv-video__trail-axis" data-axis={ev.axis}>
                      {t(ev.axis === 'COPY' ? 'video.trail.copyAxis' : 'video.trail.sourceAxis')}
                    </span>
                    {from !== null && <span className="tv-video__trail-chip">{from}</span>}
                    {from !== null && (
                      <span className="tv-video__trail-arrow" aria-hidden="true">
                        →
                      </span>
                    )}
                    <span className="tv-video__trail-chip tv-video__trail-chip--to">{to}</span>
                    {rescue && (
                      <span className="tv-video__trail-rescue">
                        <Icon name="shield-check" size={12} />
                        {t('video.trail.rescued')}
                      </span>
                    )}
                  </div>
                  {ev.note !== '' && <p className="tv-video__trail-note">{ev.note}</p>}
                  <time className="tv-video__trail-time" dateTime={ev.at}>
                    {formatRelativeTime(ev.at, i18n.language)}
                  </time>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
