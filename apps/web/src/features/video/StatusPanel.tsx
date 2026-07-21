/**
 * StatusPanel — the two orthogonal axes (CopyState = our copy, SourceState = the
 * original's availability) shown side-by-side via the DS StatusBadge, which also
 * raises the violet Rescued jewel when they align (HEALTHY + source gone). Below
 * the badges, one plain-language headline that names where this copy stands —
 * rescued overrides the copy state (§5).
 *
 * It renders as a FULL-WIDTH trust banner above the two-column layout (S5-L1): a
 * left accent bar tinted by the copy's intent, and — when rescued — the signature
 * violet wash, so the single most important line on the page reads first.
 */
import { useTranslation } from 'react-i18next';

import type { VideoDto } from '@tubevault/types';

import { COPY_INTENT, StatusBadge, isRescued, type Intent } from '../../ds';
import { headlineKey } from './video-presentation';

export interface StatusPanelProps {
  video: VideoDto;
}

export function StatusPanel({ video }: StatusPanelProps): React.ReactElement {
  const { t } = useTranslation();
  const tone: Intent = isRescued(video.copyState, video.sourceState)
    ? 'signature'
    : COPY_INTENT[video.copyState];
  return (
    <section className="tv-video__status" data-tone={tone} aria-label={t('video.statusTitle')}>
      <span className="tv-video__status-accent" aria-hidden="true" />
      <div className="tv-video__status-badges">
        <StatusBadge copyState={video.copyState} sourceState={video.sourceState} />
      </div>
      <p className="tv-video__headline">
        {t(`video.headline.${headlineKey(video.copyState, video.sourceState)}`)}
      </p>
    </section>
  );
}
