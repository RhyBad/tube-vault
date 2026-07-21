/**
 * wipeStaging robustness (P6b audit fix 8): the staging wipe is best-effort
 * cleanup — a filesystem error (NAS hiccup, permission drift) must NEVER fail
 * the cancel whose row CAS already committed. Non-ENOENT errors leave a WARN
 * JobEvent trail; ENOENT is silence (the dir is simply already gone).
 *
 * `node:fs` is module-mocked so rmSync can throw deterministically — chmod
 * tricks are root-dependent (CI containers run as root and ignore modes).
 */
import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@tubevault/db';
import type { Queue } from 'bullmq';
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { ApiConfig } from '../config';
import type { RedisPublisher } from '../redis-publisher';
import type { VideoStateService } from '../video-state.service';
import { QueueService } from './queue.service';

/** Set per-test; the mocked rmSync throws it when non-null. */
let rmError: NodeJS.ErrnoException | null = null;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    rmSync: vi.fn((...args: Parameters<typeof actual.rmSync>) => {
      if (rmError !== null) {
        throw rmError;
      }
      return actual.rmSync(...args);
    }),
  };
});

const CONFIG: ApiConfig = {
  port: 3000,
  databaseUrl: 'postgresql://unused',
  redisHost: '127.0.0.1',
  redisPort: 6379,
  accessSecretHash: 'unused',
  sessionKey: 'k'.repeat(32),
  cookieSecure: true,
  syncExtractTimeoutMs: 300_000,
  dataDir: '/data',
  vaultRoot: '/data/media',
};

function errnoError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

interface Stubs {
  service: QueueService;
  jobUpdateMany: Mock;
  jobEventCreate: Mock;
  transitionCopy: Mock;
}

function makeService(): Stubs {
  const jobFindUnique = vi.fn().mockResolvedValue({
    id: 'j1',
    type: 'DOWNLOAD',
    status: 'QUEUED',
    videoId: 'v1',
    bullJobId: null, // no execution — the wipe is the only fs touch
    stagingDir: '/data/media/UC1/v1 - t/.incoming', // inside the vault root
  });
  const jobUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const jobEventCreate = vi.fn().mockResolvedValue({});
  const prisma = {
    job: { findUnique: jobFindUnique, updateMany: jobUpdateMany },
    video: { findUnique: vi.fn().mockResolvedValue({ copyState: 'QUEUED' }) },
    jobEvent: { create: jobEventCreate },
  } as unknown as PrismaClient;
  const queue = { getJob: vi.fn() } as unknown as Queue;
  const publisher = { publish: vi.fn().mockResolvedValue(true) } as unknown as RedisPublisher;
  const transitionCopy = vi.fn().mockResolvedValue(true);
  const videoState = {
    transitionCopy,
    publishChanged: vi.fn(),
    applyTransition: vi.fn(),
  } as unknown as VideoStateService;
  return {
    service: new QueueService(prisma, queue, publisher, videoState, CONFIG),
    jobUpdateMany,
    jobEventCreate,
    transitionCopy,
  };
}

describe('QueueService.cancel — wipeStaging robustness (fix 8)', () => {
  beforeAll(() => Logger.overrideLogger(false)); // silence the expected warns
  beforeEach(() => {
    rmError = null;
  });

  it('a failing rm (EACCES) still settles the cancel and leaves a WARN JobEvent', async () => {
    rmError = errnoError('EACCES', "EACCES: permission denied, rmdir '/data/media/...'");
    const stubs = makeService();

    await expect(stubs.service.cancel('j1')).resolves.toBe('canceled');

    // The row settled and the video hopped back regardless of the fs error.
    expect(stubs.jobUpdateMany).toHaveBeenCalledTimes(1);
    expect(stubs.transitionCopy).toHaveBeenCalledWith('v1', 'QUEUED', 'CANDIDATE', 'canceled');
    // …and the failure is on the record.
    const warns = stubs.jobEventCreate.mock.calls
      .map((c) => c[0] as { data: { level: string; message: string } })
      .filter((a) => a.data.level === 'WARN');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.data.message).toMatch(/staging wipe failed/i);
  });

  it('ENOENT is silent (already gone): no JobEvent, cancel completes', async () => {
    rmError = errnoError('ENOENT', "ENOENT: no such file or directory, rmdir '...'");
    const stubs = makeService();

    await expect(stubs.service.cancel('j1')).resolves.toBe('canceled');
    expect(stubs.jobEventCreate).not.toHaveBeenCalled();
  });
});
