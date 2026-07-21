import { Controller, Inject, Sse } from '@nestjs/common';
import type {
  HeartbeatFrame,
  JobChangedFrame,
  JobProgressFrame,
  LiveChangedFrame,
  QueueReorderedFrame,
  SseFrame,
  VideoChangedFrame,
} from '@tubevault/types';
import { interval, map, merge, type Observable } from 'rxjs';

import { RedisPubSubService } from './redis-pubsub.service';

const HEARTBEAT_MS = 15_000;

interface SseMessage {
  data: SseFrame;
}

/**
 * `GET /api/events` — the one SSE stream (guarded: no cookie → 401 JSON, which
 * EventSource surfaces as an error; it never gets redirected). Emits a 15s
 * heartbeat plus job.progress / job.changed / video.changed / queue.reordered
 * / live.changed frames forwarded from Redis (PLAN.md SSE list, complete).
 */
@Controller('events')
export class EventsController {
  constructor(@Inject(RedisPubSubService) private readonly pubsub: RedisPubSubService) {}

  @Sse()
  stream(): Observable<SseMessage> {
    const heartbeat = interval(HEARTBEAT_MS).pipe(
      map((): SseMessage => ({ data: { type: 'heartbeat', ts: Date.now() } as HeartbeatFrame })),
    );
    const progress = this.pubsub.progress$.pipe(
      map((payload): SseMessage => ({
        data: { type: 'job.progress', payload } as JobProgressFrame,
      })),
    );
    const changed = this.pubsub.changed$.pipe(
      map((payload): SseMessage => ({ data: { type: 'job.changed', payload } as JobChangedFrame })),
    );
    const videoChanged = this.pubsub.videoChanged$.pipe(
      map((payload): SseMessage => ({
        data: { type: 'video.changed', payload } as VideoChangedFrame,
      })),
    );
    const reordered = this.pubsub.reordered$.pipe(
      // ts comes FROM the payload (the publish moment), not this fan-out hop.
      map((payload): SseMessage => ({
        data: { type: 'queue.reordered', ts: payload.ts } as QueueReorderedFrame,
      })),
    );
    const liveChanged = this.pubsub.liveChanged$.pipe(
      map((payload): SseMessage => ({
        data: { type: 'live.changed', payload } as LiveChangedFrame,
      })),
    );
    return merge(heartbeat, progress, changed, videoChanged, reordered, liveChanged);
  }
}
