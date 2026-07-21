/**
 * remedy — remedy-first routing per real event type (extracted from BellPopup,
 * §3a additive extension: a mechanical move, zero behavior change). Where the
 * operator resolves each notification type: credential → Settings, retry →
 * Queue, view video → detail (only when the event names a video), watch live →
 * Live, storage → Storage. Event types with no defined remedy return null (the
 * item then renders no target link).
 */
import type { NotificationDto } from '@tubevault/types';

export type RemedyKey =
  | 'shell.bell.refreshCredential'
  | 'shell.bell.retry'
  | 'shell.bell.viewVideo'
  | 'shell.bell.watchLive'
  | 'shell.bell.manageStorage';

export interface Remedy {
  labelKey: RemedyKey;
  target: string;
}

/** Remedy-first routing per real event type — where the operator resolves it. */
export function remedyFor(n: NotificationDto): Remedy | null {
  switch (n.type) {
    case 'youtube.bot_wall':
    case 'session.expired':
      return { labelKey: 'shell.bell.refreshCredential', target: '/settings' };
    case 'download.failed':
      return { labelKey: 'shell.bell.retry', target: '/queue' };
    case 'video.rescued':
    case 'source.gone':
    case 'live.stop':
      return n.videoId !== null
        ? { labelKey: 'shell.bell.viewVideo', target: `/videos/${n.videoId}` }
        : null;
    case 'live.start':
      return { labelKey: 'shell.bell.watchLive', target: '/live' };
    case 'storage.near_full':
    case 'storage.paused':
      return { labelKey: 'shell.bell.manageStorage', target: '/storage' };
    default:
      return null;
  }
}
