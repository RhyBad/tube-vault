/**
 * Player — a preservation player, not a streaming app: a plain HTML5 <video>
 * with subtitle <track>s and, crucially, a DOWNLOAD of the preserved original
 * (the archive's whole point). Same-origin media, so no crossOrigin dance.
 */
import { useTranslation } from 'react-i18next';

import { Icon } from '../icon/Icon';
import './Player.css';

export interface PlayerTrack {
  src: string;
  lang: string;
  label?: string;
  default?: boolean;
}

export interface PlayerProps {
  src: string;
  poster?: string;
  tracks?: PlayerTrack[];
  downloadUrl?: string;
  downloadLabel?: string;
  filename?: string;
  /** A short technical readout (e.g. "1080p · 1.2 GiB · mp4"). */
  meta?: string;
  /** Fired when the <video> can't load its source (e.g. media 404/416) — the
   *  consumer swaps in an inline error card. The element carries no HTTP status. */
  onError?: () => void;
  className?: string;
}

export function Player({
  src,
  poster,
  tracks,
  downloadUrl,
  downloadLabel,
  filename,
  meta,
  onError,
  className,
}: PlayerProps): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className={`tv-player${className ? ` ${className}` : ''}`}>
      <video
        className="tv-player__video"
        src={src}
        poster={poster}
        controls
        preload="metadata"
        onError={onError}
      >
        {tracks?.map((tr) => (
          <track
            key={tr.lang}
            kind="subtitles"
            src={tr.src}
            srcLang={tr.lang}
            label={tr.label ?? tr.lang}
            default={tr.default}
          />
        ))}
      </video>
      {(downloadUrl !== undefined || meta !== undefined) && (
        <div className="tv-player__bar">
          {meta !== undefined && <span className="tv-player__meta tv-numeric">{meta}</span>}
          {downloadUrl !== undefined && (
            <a className="tv-player__download" href={downloadUrl} download={filename ?? true}>
              <Icon name="download" size={15} />
              {downloadLabel ?? t('player.download')}
            </a>
          )}
        </div>
      )}
    </div>
  );
}
