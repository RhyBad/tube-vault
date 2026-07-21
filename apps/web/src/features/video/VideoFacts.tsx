/**
 * VideoFacts — the objective record: type, resolution, size, duration, added
 * date, and the video id, plus the integrity marker (was this copy checksummed?)
 * and, once verified, the full SHA-256 hash of the preserved media — the raw
 * trust affordance a preservation tool must show in full, never truncated (S5).
 * Numbers use the locale-neutral lib/format readouts; the date is localized.
 * Unknown fields render an em dash so the rows stay aligned (§3).
 */
import { useTranslation } from 'react-i18next';

import type { VideoDto } from '@tubevault/types';

import { Icon, type IconName } from '../../ds';
import { formatBytes, formatDuration } from '../../lib/format';
import { formatLocaleDate } from '../../i18n/format';
import { integrityKey, type IntegrityKey } from './video-presentation';

const DASH = '—';

const INTEGRITY_ICON: Record<IntegrityKey, IconName> = {
  verified: 'shield-check',
  partial: 'alert',
  failed: 'alert',
  pending: 'clock',
};

export interface VideoFactsProps {
  video: VideoDto;
}

export function VideoFacts({ video }: VideoFactsProps): React.ReactElement {
  const { t, i18n } = useTranslation();
  const resolution =
    video.width !== null && video.height !== null ? `${video.width} × ${video.height}` : DASH;
  const marker = integrityKey(video.copyState);

  const rows: { label: string; value: string; mono?: boolean }[] = [
    { label: t('video.facts.type'), value: t(`video.contentType.${video.contentType}`) },
    { label: t('video.facts.resolution'), value: resolution, mono: true },
    { label: t('video.facts.size'), value: formatBytes(video.sizeBytes), mono: true },
    {
      label: t('video.facts.duration'),
      value: formatDuration(video.sourceDurationSeconds),
      mono: true,
    },
    { label: t('video.facts.added'), value: formatLocaleDate(video.addedAt, i18n.language) },
    { label: t('video.facts.videoId'), value: video.id, mono: true },
  ];

  return (
    <section className="tv-video__facts" aria-label={t('video.facts.title')}>
      <div className="tv-video__integrity" data-marker={marker}>
        <Icon name={INTEGRITY_ICON[marker]} size={15} />
        <span>{t(`video.integrity.${marker}`)}</span>
      </div>
      <dl className="tv-video__factlist">
        {rows.map((row) => (
          <div className="tv-video__fact" key={row.label}>
            <dt className="tv-video__fact-label">{row.label}</dt>
            <dd className={`tv-video__fact-value${row.mono ? ' tv-numeric' : ''}`}>{row.value}</dd>
          </div>
        ))}
        {/* S5: the verify-time sha256 (null until HEALTHY). Shown in FULL on its
            own stacked line so all 64 hex chars are legible in the 340px rail —
            the checksum IS the proof the copy is intact, so it is never elided. */}
        {video.checksumSha256 !== null && video.checksumSha256 !== '' && (
          <div className="tv-video__fact tv-video__fact--checksum">
            <dt className="tv-video__fact-label">{t('video.facts.checksum')}</dt>
            <dd className="tv-video__fact-value tv-video__checksum-value">
              {video.checksumSha256}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}
