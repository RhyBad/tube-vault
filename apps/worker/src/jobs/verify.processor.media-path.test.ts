/**
 * VerifyConsumer media-path guard (P9 audit): `Video.mediaExt` is a DB string
 * joined into the probe path — a hostile row (`x/../../../etc/passwd`) must
 * terminal-fail the job CLEANLY (row FAILED + video VERIFYING→FAILED) without
 * ever probing the traversal target. Pure unit drive: every port is a fake,
 * `runFfprobe` is mocked so "never invoked" is directly observable.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@tubevault/db';
import { runFfprobe, type EngineConfig } from '@tubevault/engine';
import { UnrecoverableError } from 'bullmq';
import type { Job as BullJob } from 'bullmq';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkerConfig } from '../config';
import type { JobRecorder } from './job-recorder';
import type { RedisPublisher } from '../redis-publisher';
import type { NotificationsService } from '../services/notifications.service';
import type { VideoStateService } from '../services/video-state.service';
import { VerifyConsumer } from './verify.processor';

vi.mock('@tubevault/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tubevault/engine')>();
  return { ...actual, runFfprobe: vi.fn() };
});

const JOB_ID = 'job-hostile-ext';
const VIDEO_ID = 'hostilevid1';
const CH = 'UChostilechannel00000001';

// Deep enough to climb out of any tmp vault; /etc/passwd EXISTS on the
// runner, so a missing guard would happily existsSync+probe it.
const HOSTILE_EXT = `x/${'../'.repeat(12)}etc/passwd`;

describe('VerifyConsumer hostile mediaExt', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tubevault-verify-guard-'));

  const recorder = {
    claimForAttempt: vi.fn().mockResolvedValue(true),
    markFinished: vi.fn().mockResolvedValue(true),
    markRequeuedForRetry: vi.fn().mockResolvedValue(undefined),
    event: vi.fn().mockResolvedValue(undefined),
  };
  const publisher = { publish: vi.fn().mockResolvedValue(undefined) };
  const videoState = { transitionCopy: vi.fn().mockResolvedValue(true) };
  const notifications = { emitDownloadFailed: vi.fn().mockResolvedValue(undefined) };
  const prisma = {
    job: {
      findUnique: vi.fn().mockResolvedValue({ id: JOB_ID, videoId: VIDEO_ID, status: 'QUEUED' }),
    },
    video: {
      findUnique: vi.fn().mockResolvedValue({
        id: VIDEO_ID,
        channelId: CH,
        title: 'Hostile ext row',
        copyState: 'VERIFYING',
        mediaExt: HOSTILE_EXT,
        sourceDurationSeconds: null,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
  };

  const consumer = new VerifyConsumer(
    { vaultRoot: join(dataDir, 'media'), redisHost: 'unused', redisPort: 0 } as WorkerConfig,
    { ffprobeBin: 'ffprobe' } as EngineConfig,
    prisma as unknown as PrismaClient,
    recorder as unknown as JobRecorder,
    publisher as unknown as RedisPublisher,
    videoState as unknown as VideoStateService,
    notifications as unknown as NotificationsService,
  );

  const bullJob = {
    data: { jobId: JOB_ID },
    id: 'bull-1',
    attemptsStarted: 1,
    attemptsMade: 0,
    opts: { attempts: 1 },
  } as unknown as BullJob;

  beforeEach(() => {
    vi.mocked(runFfprobe).mockClear();
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('terminal-fails cleanly: row FAILED, video VERIFYING→FAILED, ffprobe NEVER touches the traversal target', async () => {
    await expect(consumer.process(bullJob)).rejects.toBeInstanceOf(UnrecoverableError);

    expect(runFfprobe).not.toHaveBeenCalled(); // the guard fires BEFORE any disk probe
    expect(recorder.markFinished).toHaveBeenCalledWith(
      JOB_ID,
      'FAILED',
      expect.objectContaining({ error: expect.stringContaining('media path') as unknown }),
    );
    expect(videoState.transitionCopy).toHaveBeenCalledWith(
      VIDEO_ID,
      'VERIFYING',
      'FAILED',
      expect.stringContaining('verify failed') as unknown as string,
    );
  });
});
