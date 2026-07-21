import { describe, expect, it } from 'vitest';

import {
  ACTIVE_JOB_STATUSES,
  BULLMQ_QUEUE_COMPLETENESS_SCAN,
  BULLMQ_QUEUE_DOWNLOAD,
  BULLMQ_QUEUE_ENUMERATE,
  BULLMQ_QUEUE_LIVE_CAPTURE,
  BULLMQ_QUEUE_LIVE_PROBE,
  BULLMQ_QUEUE_LIVE_SCAN,
  BULLMQ_QUEUE_SOURCE_CHECK,
  BULLMQ_QUEUE_SOURCE_CHECK_SCAN,
  BULLMQ_QUEUE_VERIFY,
  REDIS_CHANNEL_JOB_CHANGED,
  REDIS_CHANNEL_JOB_CONTROL,
  REDIS_CHANNEL_JOB_PROGRESS,
  REDIS_CHANNEL_LIVE_CHANGED,
  REDIS_CHANNEL_QUEUE_REORDERED,
  REDIS_CHANNEL_VIDEO_CHANGED,
  TERMINAL_JOB_STATUSES,
  downloadAddOptions,
  enumerateAddOptions,
  isActiveJobStatus,
  isTerminalJobStatus,
  liveCaptureAddOptions,
  liveProbeAddOptions,
  verifyAddOptions,
  type AddVideoByUrlResponse,
  type ChannelDto,
  type ChannelListResponse,
  type ChannelVideosResponse,
  type DeleteChannelResponse,
  type DeleteVideosResponse,
  type JobControlMessage,
  type JobStatus,
  type RegisterChannelRequest,
  type RegisterChannelResponse,
  type SseFrame,
  type VideoDeleteMode,
  type VideoDeleteReason,
  VIDEO_DELETE_REASONS,
  type VideoDto,
  type VideoSort,
} from './index.js';

const ALL_STATUSES: readonly JobStatus[] = [
  'QUEUED',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'CANCELED',
];

describe('job status partitions', () => {
  it('every status is exactly one of active or terminal', () => {
    for (const status of ALL_STATUSES) {
      expect(isActiveJobStatus(status) !== isTerminalJobStatus(status)).toBe(true);
    }
    expect([...ACTIVE_JOB_STATUSES, ...TERMINAL_JOB_STATUSES].sort()).toEqual(
      [...ALL_STATUSES].sort(),
    );
  });

  it('paused occupies the queue; canceled is history', () => {
    expect(isActiveJobStatus('PAUSED')).toBe(true);
    expect(isTerminalJobStatus('CANCELED')).toBe(true);
  });
});

describe('SSE frames + job control (PLAN.md shapes)', () => {
  it('the frame union discriminates on `type` (PLAN.md SSE frame list)', () => {
    const frames: SseFrame[] = [
      { type: 'heartbeat', ts: 1 },
      {
        type: 'job.progress',
        payload: {
          jobId: 'j1',
          videoId: 'v1',
          pct: 42.5,
          downloadedBytes: 1024,
          totalBytes: null,
          speedBps: null,
          etaSeconds: null,
          currentFile: null,
        },
      },
      {
        type: 'job.changed',
        payload: {
          jobId: 'j1',
          type: 'DOWNLOAD',
          status: 'RUNNING',
          videoId: 'v1',
          errorKind: null,
        },
      },
      {
        type: 'video.changed',
        payload: {
          videoId: 'v1',
          channelId: 'UC1',
          copyState: 'HEALTHY',
          sourceState: 'AVAILABLE',
        },
      },
      { type: 'live.changed', payload: { videoId: 'v1', channelId: 'UC1', state: 'CAPTURING' } },
      { type: 'queue.reordered', ts: 2 },
    ];
    expect(new Set(frames.map((f) => f.type)).size).toBe(6);
    const first = frames[0];
    if (first?.type === 'heartbeat') expect(first.ts).toBe(1); // narrowing compiles
  });

  it('redis channel names are the PLAN.md queue-mechanics contract', () => {
    expect(REDIS_CHANNEL_JOB_PROGRESS).toBe('job:progress');
    expect(REDIS_CHANNEL_JOB_CHANGED).toBe('job:changed');
    expect(REDIS_CHANNEL_JOB_CONTROL).toBe('job:control');
    expect(REDIS_CHANNEL_VIDEO_CHANGED).toBe('video:changed');
    expect(REDIS_CHANNEL_QUEUE_REORDERED).toBe('queue:reordered');
    const msg: JobControlMessage = { action: 'cancel', jobId: 'j1' };
    expect(msg.action).toBe('cancel');
  });
});

describe('download/verify queue contract (P6)', () => {
  it("queue names are 'download' and 'verify' (api producer + worker consumer agree)", () => {
    expect(BULLMQ_QUEUE_DOWNLOAD).toBe('download');
    expect(BULLMQ_QUEUE_VERIFY).toBe('verify');
  });

  it('downloadAddOptions is the ONE canonical option set (PLAN.md retry policy: attempts 5, exp 30s)', () => {
    expect(downloadAddOptions('row1', 1_048_576)).toEqual({
      jobId: 'row1',
      priority: 1_048_576,
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  });

  it('downloadAddOptions REJECTS 0/null/non-integer/out-of-range priorities (BullMQ: 0 or absent BEATS every prioritized job)', () => {
    expect(() => downloadAddOptions('row1', 0)).toThrow(RangeError);
    expect(() => downloadAddOptions('row1', null as unknown as number)).toThrow(RangeError);
    expect(() => downloadAddOptions('row1', 1.5)).toThrow(RangeError);
    expect(() => downloadAddOptions('row1', -1)).toThrow(RangeError);
    expect(() => downloadAddOptions('row1', Number.NaN)).toThrow(RangeError);
    expect(() => downloadAddOptions('row1', Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => downloadAddOptions('row1', 2_097_153)).toThrow(RangeError); // > BullMQ max (2^21)
    // Bounds are inclusive.
    expect(downloadAddOptions('row1', 1).priority).toBe(1);
    expect(downloadAddOptions('row1', 2_097_152).priority).toBe(2_097_152);
  });

  it('enumerateAddOptions is THE canonical ENUMERATE option set (api producer + boot reconciler both import it)', () => {
    expect(enumerateAddOptions('row3')).toEqual({
      jobId: 'row3',
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  });

  it('verifyAddOptions: attempts 3, exp backoff 30s, no priority', () => {
    expect(verifyAddOptions('row2')).toEqual({
      jobId: 'row2',
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  });
});

describe('live queue contract (P10)', () => {
  it("queue names are 'live-scan' / 'live-probe' / 'live-capture'; the frame channel is 'live:changed'", () => {
    expect(BULLMQ_QUEUE_LIVE_SCAN).toBe('live-scan');
    expect(BULLMQ_QUEUE_LIVE_PROBE).toBe('live-probe');
    expect(BULLMQ_QUEUE_LIVE_CAPTURE).toBe('live-capture');
    expect(REDIS_CHANNEL_LIVE_CHANGED).toBe('live:changed');
  });

  it("archive-role scan queues: 'source-check(-scan)' (CR-09) + 'completeness-scan' (CR-20)", () => {
    expect(BULLMQ_QUEUE_SOURCE_CHECK_SCAN).toBe('source-check-scan');
    expect(BULLMQ_QUEUE_SOURCE_CHECK).toBe('source-check');
    expect(BULLMQ_QUEUE_COMPLETENESS_SCAN).toBe('completeness-scan');
  });

  it('liveProbeAddOptions: attempts 1 (a missed probe is retried by the next scan tick, never BullMQ)', () => {
    expect(liveProbeAddOptions('row4')).toEqual({
      jobId: 'row4',
      attempts: 1,
      backoff: { type: 'fixed', delay: 0 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  });

  it('liveCaptureAddOptions: attempts 1 (capture restarts are SESSION-level decisions, not BullMQ retries)', () => {
    expect(liveCaptureAddOptions('row5')).toEqual({
      jobId: 'row5',
      attempts: 1,
      backoff: { type: 'fixed', delay: 0 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  });

  it('LiveChangedFrame carries videoId/channelId/state (+ optional sessionId) for the dashboard', () => {
    const frame: SseFrame = {
      type: 'live.changed',
      payload: {
        videoId: 'livebcast01',
        channelId: 'UClive',
        state: 'CAPTURING',
        sessionId: 'sess1',
      },
    };
    expect(frame.type).toBe('live.changed');
  });
});

describe('channels/videos API contract (P5)', () => {
  it("the ENUMERATE BullMQ queue name is 'enumerate' (api producer + worker consumer agree)", () => {
    expect(BULLMQ_QUEUE_ENUMERATE).toBe('enumerate');
  });

  it('DTOs are browser-safe (ISO-string dates, number bytes) — narrowing compiles', () => {
    const channel: ChannelDto = {
      id: 'UC1',
      url: 'https://www.youtube.com/channel/UC1',
      title: 'A channel',
      handle: '@a',
      watchLive: false,
      qualityCap: 'P1080',
      subtitleMode: null,
      unregisteredAt: null,
      lastEnumeratedAt: null,
      createdAt: '2026-07-02T00:00:00.000Z',
      videoCounts: { total: 3, candidates: 2, healthy: 1 },
    };
    const video: VideoDto = {
      id: 'v1',
      channelId: 'UC1',
      title: 'A video',
      contentType: 'LIVE',
      copyState: 'CANDIDATE',
      sourceState: 'UNKNOWN',
      publishedAt: null,
      addedAt: '2026-07-02T00:00:00.000Z',
      mediaExt: null,
      sizeBytes: null,
      checksumSha256: null,
      width: null,
      height: null,
      sourceDurationSeconds: 3600,
    };
    const register: RegisterChannelRequest = { url: channel.url };
    const registered: RegisterChannelResponse = {
      channel,
      enumerateJobId: 'job1',
      alreadyRegistered: false,
    };
    const list: ChannelListResponse = { channels: [channel] };
    const videos: ChannelVideosResponse = { videos: [video], total: 1 };
    const added: AddVideoByUrlResponse = { video, created: true };
    const unregistered: DeleteChannelResponse = {
      channelId: channel.id,
      mode: 'unregistered',
      videosDeleted: 0,
      mediaPurged: false,
    };
    const purged: DeleteChannelResponse = {
      channelId: channel.id,
      mode: 'purged',
      videosDeleted: 7,
      mediaPurged: true,
    };
    const sorts: VideoSort[] = [
      'publishedAt_desc',
      'publishedAt_asc',
      'addedAt_desc',
      'title_asc',
      'sizeBytes_desc',
      'sizeBytes_asc',
    ];
    expect(register.url).toBe(channel.url);
    expect(registered.alreadyRegistered).toBe(false);
    expect(list.channels).toHaveLength(1);
    expect(videos.total).toBe(1);
    expect(added.created).toBe(true);
    expect(unregistered.mediaPurged).toBe(false);
    expect(purged.videosDeleted).toBe(7);
    expect(sorts).toHaveLength(6);
  });
});

describe('CR-27 video deletion verdict types', () => {
  it('VIDEO_DELETE_REASONS is the runtime mirror of VideoDeleteReason', () => {
    const reasons: VideoDeleteReason[] = ['not_found', 'active_job', 'not_eligible', 'fs_error'];
    // Every reason in the union appears in the runtime mirror and vice-versa.
    expect([...VIDEO_DELETE_REASONS].sort()).toEqual([...reasons].sort());
  });

  it('DeleteVideosResponse carries per-id verdicts + freedBytes (both endpoints share it)', () => {
    const modes: VideoDeleteMode[] = ['reclaim', 'purge'];
    const resp: DeleteVideosResponse = {
      deleted: ['vid1', 'vid2'],
      freedBytes: 4096,
      failed: [
        { videoId: 'vid3', reason: 'active_job' },
        { videoId: 'vid4', reason: 'not_eligible' },
      ],
    };
    expect(modes).toHaveLength(2);
    expect(resp.deleted).toHaveLength(2);
    expect(resp.freedBytes).toBe(4096);
    expect(resp.failed.map((f) => f.reason)).toEqual(['active_job', 'not_eligible']);
  });
});
