/**
 * Queue/Settings API contract (P6b — PLAN.md "Queue API surface"). Runtime
 * pieces (the skip-reason + enqueue-eligible constants) are asserted directly;
 * the DTO shapes are locked the same way the P5 DTOs are — typed construction
 * that must compile (tsc checks them via the api's mappers, which annotate
 * their return types with these interfaces).
 */
import { describe, expect, it } from 'vitest';

import {
  ENQUEUEABLE_COPY_STATES,
  ENQUEUE_SKIP_REASONS,
  type EnqueueRequest,
  type EnqueueResponse,
  type EnqueueSkipReason,
  type JobEventDto,
  type JobEventsResponse,
  type QueueItemDto,
  type QueueListResponse,
  type SettingsDto,
  type UpdateSettingsRequest,
} from './index.js';

describe('enqueue contract (P6b)', () => {
  it('skip reasons are exactly the four PLAN.md outcomes + enqueue_failed + the P10 live-capture guard', () => {
    expect([...ENQUEUE_SKIP_REASONS].sort()).toEqual([
      'already_queued',
      'enqueue_failed',
      'live_capture_active',
      'live_retry_refused',
      'not_eligible',
      'not_found',
    ]);
  });

  it('enqueue-eligible copy states are CANDIDATE | FAILED | PARTIAL_KEPT (PLAN.md enqueue filter)', () => {
    expect([...ENQUEUEABLE_COPY_STATES]).toEqual(['CANDIDATE', 'FAILED', 'PARTIAL_KEPT']);
  });

  it('EnqueueRequest/Response shapes — narrowing compiles', () => {
    const byIds: EnqueueRequest = { videoIds: ['v1', 'v2'] };
    const byFilter: EnqueueRequest = {
      filter: { channelId: 'UC1', copyState: 'FAILED', search: 'needle' },
    };
    const mixed: EnqueueRequest = { videoIds: ['v1'], filter: { channelId: 'UC1' } };
    const reason: EnqueueSkipReason = 'live_retry_refused';
    const response: EnqueueResponse = {
      enqueued: ['v1'],
      skipped: [{ videoId: 'v2', reason }],
    };
    expect(byIds.videoIds).toHaveLength(2);
    expect(byFilter.filter?.copyState).toBe('FAILED');
    expect(mixed.filter?.channelId).toBe('UC1');
    expect(response.skipped[0]?.reason).toBe('live_retry_refused');
  });
});

describe('queue listing + job events contract (P6b)', () => {
  it('QueueItemDto is browser-safe (ISO dates, number bytes) — narrowing compiles', () => {
    const running: QueueItemDto = {
      jobId: 'j1',
      videoId: 'v1',
      title: 'A video',
      channelId: 'UC1',
      channelTitle: 'A channel',
      status: 'RUNNING',
      priority: 1_048_576,
      attempt: 0,
      progress: {
        pct: 42.5,
        downloadedBytes: 1024,
        totalBytes: null,
        speedBps: 2048.5,
        etaSeconds: 30,
        currentFile: 'v1.mp4',
      },
      errorKind: null,
      error: null,
      enqueuedAt: '2026-07-02T00:00:00.000Z',
      startedAt: '2026-07-02T00:00:01.000Z',
      pausedAt: null,
      finishedAt: null,
    };
    const queued: QueueItemDto = {
      ...running,
      jobId: 'j2',
      status: 'QUEUED',
      progress: null, // never-started rows carry no progress object
      startedAt: null,
    };
    const paused: QueueItemDto = {
      ...running,
      jobId: 'j3',
      status: 'PAUSED',
      // The P7 pause/resume contract: a PAUSED row exposes WHEN it was paused.
      pausedAt: '2026-07-02T00:00:02.000Z',
    };
    expect(paused.pausedAt).toBe('2026-07-02T00:00:02.000Z');
    const list: QueueListResponse = { items: [running, queued], nextCursor: 'b64cursor' };
    const done: QueueListResponse = { items: [], nextCursor: null };
    expect(list.items).toHaveLength(2);
    expect(list.items[1]?.progress).toBeNull();
    expect(done.nextCursor).toBeNull();
  });

  it('JobEventDto/JobEventsResponse — narrowing compiles', () => {
    const event: JobEventDto = {
      id: 'e1',
      level: 'ERROR',
      message: 'yt-dlp exited with 1',
      context: { stderrTail: ['ERROR: something'] },
      createdAt: '2026-07-02T00:00:00.000Z',
    };
    const events: JobEventsResponse = { events: [event] };
    expect(events.events[0]?.level).toBe('ERROR');
  });
});

describe('settings contract (P6b)', () => {
  it('SettingsDto mirrors the Settings singleton; the patch is partial — narrowing compiles', () => {
    const dto: SettingsDto = {
      downloadConcurrency: 1,
      qualityCap: 'UNLIMITED',
      subtitleMode: 'BOTH',
    };
    const patchOne: UpdateSettingsRequest = { downloadConcurrency: 4 };
    const patchAll: UpdateSettingsRequest = {
      downloadConcurrency: 2,
      qualityCap: 'P1080',
      subtitleMode: 'NONE',
    };
    expect(dto.downloadConcurrency).toBe(1);
    expect(patchOne.qualityCap).toBeUndefined();
    expect(patchAll.subtitleMode).toBe('NONE');
  });
});
