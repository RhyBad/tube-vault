/**
 * PlayerPanel — the media region, which is one of three things:
 *
 *  1. no preserved media (`mediaExt === null`) → a state-specific "absent" card
 *     (EP-17 would 404); play/download don't exist yet.
 *  2. a playback error (the <video> couldn't load its source) → an INLINE error
 *     card, never a full-screen error — the record below is still trustworthy.
 *     The element exposes no HTTP status, so we show the "couldn't read" (404)
 *     copy and offer a reload (which remounts the player to re-attempt).
 *  3. otherwise → the DS Player: <video> + subtitle tracks + the download of the
 *     preserved original (the archive's whole point). First track is default.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { SubtitleTrackDto, VideoDto } from '@tubevault/types';

import { Button, EmptyState, Icon, Player, type IconName, type PlayerTrack } from '../../ds';
import { absentKey, hasMedia, playerMeta, type AbsentKey } from './video-presentation';
import { mediaUrl, subtitleTrackUrl, thumbnailUrl } from './video-api';

const ABSENT_ICON: Record<AbsentKey, IconName> = {
  DOWNLOADING: 'loader',
  QUEUED: 'clock',
  FAILED: 'x-octagon',
  CANDIDATE: 'download',
};

export interface PlayerPanelProps {
  video: VideoDto;
  subtitles: SubtitleTrackDto[];
}

export function PlayerPanel({ video, subtitles }: PlayerPanelProps): React.ReactElement {
  const { t } = useTranslation();
  const [errored, setErrored] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  if (!hasMedia(video)) {
    const key = absentKey(video.copyState);
    const spinning = key === 'DOWNLOADING';
    return (
      <div className="tv-video__player-region">
        <EmptyState
          className="tv-video__absent"
          icon={ABSENT_ICON[key]}
          iconSpin={spinning}
          title={t(`video.absent.${key}.title`)}
          description={t(`video.absent.${key}.body`)}
        />
        {spinning && (
          <span className="tv-sr-only" role="status">
            {t(`video.absent.${key}.title`)}
          </span>
        )}
      </div>
    );
  }

  if (errored) {
    return (
      <div className="tv-video__player-region">
        <div className="tv-video__player-error" role="alert">
          <Icon name="alert" size={22} />
          <div>
            <h3 className="tv-video__player-error-title">{t('video.playerError.e404.title')}</h3>
            <p className="tv-video__player-error-body">{t('video.playerError.e404.body')}</p>
          </div>
          <Button
            variant="secondary"
            icon="retry"
            onClick={() => {
              setErrored(false);
              setReloadKey((k) => k + 1);
            }}
          >
            {t('video.playerError.reload')}
          </Button>
        </div>
      </div>
    );
  }

  const tracks: PlayerTrack[] = subtitles.map((s, i) => ({
    src: subtitleTrackUrl(video.id, s.lang),
    lang: s.lang,
    label: s.label,
    default: i === 0,
  }));

  return (
    <div className="tv-video__player-region">
      <Player
        key={reloadKey}
        src={mediaUrl(video.id)}
        poster={thumbnailUrl(video.id)}
        tracks={tracks}
        downloadUrl={mediaUrl(video.id)}
        downloadLabel={t('video.download')}
        filename={`${video.id}.${video.mediaExt ?? 'mp4'}`}
        meta={playerMeta(video)}
        onError={() => setErrored(true)}
      />
    </div>
  );
}
