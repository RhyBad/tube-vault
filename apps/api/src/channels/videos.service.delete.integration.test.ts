/**
 * CR-27 VideosService.deleteVideos integration (pg testcontainer + a real
 * LocalFileStore on a temp vault + a frame-capturing fake publisher). Pins the
 * owner-specified reclaim/purge semantics + guards + the fs-error truthfulness:
 *
 *  - RECLAIM: media dir wiped, row → CANDIDATE, media metadata cleared, freedBytes
 *    = prior sizeBytes, video:changed(CANDIDATE), re-enqueueable (trail records it),
 *  - PURGE: row + media gone, Job/LiveSession/VideoStatusEvent cascade, freedBytes,
 *  - active-job (DOWNLOAD QUEUED/RUNNING/PAUSED | LIVE_CAPTURE QUEUED/RUNNING) → skip,
 *  - not_eligible (a CANDIDATE holds no media),
 *  - fs_error: the DB change STANDS (row gone / CANDIDATE) but the id is reported,
 *  - bulk mixed-outcome { deleted, freedBytes, failed } in id order.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@tubevault/db';
import { LocalFileStore } from '@tubevault/storage';
import { REDIS_CHANNEL_VIDEO_CHANGED } from '@tubevault/types';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type ApiConfig } from '../config';
import { RedisPublisher } from '../redis-publisher';
import { VideoStateService } from '../video-state.service';
import { VideosService } from './videos.service';

const CHANNEL = 'UCdelete00000000000000000';

const migrationsDir = fileURLToPath(
  new URL('../../../../packages/db/prisma/migrations', import.meta.url),
);

async function applyMigrations(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const dirs = readdirSync(migrationsDir)
      .filter((d) => /^\d/.test(d))
      .sort();
    for (const dir of dirs) {
      await client.query(readFileSync(path.join(migrationsDir, dir, 'migration.sql'), 'utf8'));
    }
  } finally {
    await client.end();
  }
}

describe('VideosService.deleteVideos (pg testcontainer + temp vault)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let vaultRoot: string;
  let store: LocalFileStore;
  let videos: VideosService;
  let seq = 0;
  const frames: { channel: string; payload: { videoId: string; copyState: string } }[] = [];

  const fakePublisher = {
    publish: (channel: string, payload: unknown): Promise<boolean> => {
      frames.push({ channel, payload: payload as { videoId: string; copyState: string } });
      return Promise.resolve(true);
    },
  } as unknown as RedisPublisher;

  beforeAll(async () => {
    pgContainer = await new PostgreSqlContainer('postgres:17-alpine').start();
    await applyMigrations(pgContainer.getConnectionUri());
    prisma = new PrismaClient({ datasourceUrl: pgContainer.getConnectionUri() });
    vaultRoot = mkdtempSync(join(tmpdir(), 'tv-delete-'));
    store = new LocalFileStore(vaultRoot); // seeds media on disk; the service builds its own from config
    const videoState = new VideoStateService(prisma, fakePublisher);
    videos = new VideosService(prisma, videoState, { vaultRoot } as unknown as ApiConfig);
    await prisma.channel.create({
      data: { id: CHANNEL, url: 'https://www.youtube.com/@del', title: 'Delete channel' },
    });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pgContainer?.stop();
    if (vaultRoot) rmSync(vaultRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await prisma.video.deleteMany({ where: { channelId: CHANNEL } });
    frames.length = 0;
  });

  /** Seed a video (+ its on-disk media dir when it holds media). */
  async function seed(opts: {
    copyState: 'HEALTHY' | 'PARTIAL_KEPT' | 'CANDIDATE';
    sizeBytes?: bigint;
    withMedia?: boolean;
  }): Promise<{ id: string; dir: string | null }> {
    seq += 1;
    const id = `delvid${String(seq).padStart(5, '0')}`;
    const holds = opts.withMedia ?? false;
    await prisma.video.create({
      data: {
        id,
        channelId: CHANNEL,
        title: `Video ${id}`,
        contentType: 'REGULAR',
        copyState: opts.copyState,
        mediaExt: holds ? 'mp4' : null,
        sizeBytes: opts.sizeBytes ?? null,
        checksumSha256: holds ? 'deadbeef' : null,
        width: holds ? 1920 : null,
        height: holds ? 1080 : null,
        sourceDurationSeconds: holds ? 12.5 : null,
      },
    });
    let dir: string | null = null;
    if (holds) {
      const paths = store.pathsFor(CHANNEL, id, `Video ${id}`);
      store.ensureDir(paths);
      writeFileSync(paths.media('mp4'), Buffer.alloc(1024, 7));
      dir = paths.directory;
    }
    return { id, dir };
  }

  it('RECLAIM: media wiped, row→CANDIDATE, metadata cleared, freedBytes, video:changed, re-enqueueable', async () => {
    const { id, dir } = await seed({ copyState: 'HEALTHY', sizeBytes: 4096n, withMedia: true });

    const res = await videos.deleteVideos([id], 'reclaim');
    expect(res).toEqual({ deleted: [id], freedBytes: 4096, failed: [] });

    const v = await prisma.video.findUniqueOrThrow({ where: { id } });
    expect(v.copyState).toBe('CANDIDATE'); // re-downloadable via EP-19
    expect(v.mediaExt).toBeNull();
    expect(v.sizeBytes).toBeNull();
    expect(v.checksumSha256).toBeNull();
    expect(v.width).toBeNull();
    expect(v.height).toBeNull();
    expect(v.sourceDurationSeconds).toBeNull();

    expect(existsSync(dir as string)).toBe(false); // media dir gone

    // a COPY trail event HEALTHY→CANDIDATE (audit) + a video:changed(CANDIDATE) frame
    const trail = await prisma.videoStatusEvent.findMany({ where: { videoId: id, axis: 'COPY' } });
    expect(trail.some((e) => e.oldState === 'HEALTHY' && e.newState === 'CANDIDATE')).toBe(true);
    expect(frames).toContainEqual({
      channel: REDIS_CHANNEL_VIDEO_CHANGED,
      payload: expect.objectContaining({ videoId: id, copyState: 'CANDIDATE' }),
    });
  }, 60_000);

  it('PURGE: row + media gone, Job/status-event cascade, freedBytes, video:changed', async () => {
    const { id, dir } = await seed({ copyState: 'HEALTHY', sizeBytes: 8192n, withMedia: true });
    await prisma.job.create({ data: { type: 'DOWNLOAD', status: 'COMPLETED', videoId: id } });

    const res = await videos.deleteVideos([id], 'purge');
    expect(res.deleted).toEqual([id]);
    expect(res.freedBytes).toBe(8192);
    expect(res.failed).toEqual([]);

    expect(await prisma.video.findUnique({ where: { id } })).toBeNull();
    expect(await prisma.job.count({ where: { videoId: id } })).toBe(0); // cascade
    expect(await prisma.videoStatusEvent.count({ where: { videoId: id } })).toBe(0); // cascade
    expect(existsSync(dir as string)).toBe(false);
    expect(frames.some((f) => f.payload.videoId === id)).toBe(true);
  }, 60_000);

  it('active_job: an active DOWNLOAD blocks the delete (skip, row + media untouched)', async () => {
    const { id, dir } = await seed({ copyState: 'HEALTHY', sizeBytes: 4096n, withMedia: true });
    await prisma.job.create({ data: { type: 'DOWNLOAD', status: 'QUEUED', videoId: id } });

    const res = await videos.deleteVideos([id], 'purge');
    expect(res.failed).toEqual([{ videoId: id, reason: 'active_job' }]);
    expect(res.deleted).toEqual([]);

    expect(await prisma.video.findUnique({ where: { id } })).not.toBeNull();
    expect(existsSync(dir as string)).toBe(true);
  }, 60_000);

  it('not_eligible: RECLAIM of a CANDIDATE (no media) frees nothing', async () => {
    const { id } = await seed({ copyState: 'CANDIDATE', withMedia: false });
    const res = await videos.deleteVideos([id], 'reclaim');
    expect(res).toEqual({
      deleted: [],
      freedBytes: 0,
      failed: [{ videoId: id, reason: 'not_eligible' }],
    });
  }, 60_000);

  // A VideosService whose on-disk wipe ALWAYS fails — deterministically
  // simulates a real fs error (EACCES/EBUSY/…) that removeDirWithinRoot surfaces.
  class FsErrorVideos extends VideosService {
    protected override deleteVideoDir(): void {
      throw new Error('simulated disk failure');
    }
  }
  const makeFsErrorVideos = (): VideosService =>
    new FsErrorVideos(prisma, new VideoStateService(prisma, fakePublisher), {
      vaultRoot,
    } as unknown as ApiConfig);

  it('fs_error (PURGE): the DB delete STANDS, the id is reported, no freedBytes', async () => {
    const { id } = await seed({ copyState: 'HEALTHY', sizeBytes: 4096n, withMedia: true });
    const res = await makeFsErrorVideos().deleteVideos([id], 'purge');
    expect(res).toEqual({
      deleted: [],
      freedBytes: 0,
      failed: [{ videoId: id, reason: 'fs_error' }],
    });
    expect(await prisma.video.findUnique({ where: { id } })).toBeNull(); // DB is truth
  }, 60_000);

  it('fs_error (RECLAIM): the reclaim transition STANDS even when the wipe fails', async () => {
    const { id } = await seed({ copyState: 'HEALTHY', sizeBytes: 4096n, withMedia: true });
    const res = await makeFsErrorVideos().deleteVideos([id], 'reclaim');
    expect(res.failed).toEqual([{ videoId: id, reason: 'fs_error' }]);
    const v = await prisma.video.findUniqueOrThrow({ where: { id } });
    expect(v.copyState).toBe('CANDIDATE'); // the DB reclaim committed
    expect(v.sizeBytes).toBeNull();
  }, 60_000);

  it('bulk mixed-outcome: { deleted, freedBytes, failed } in id order', async () => {
    const healthy = await seed({ copyState: 'HEALTHY', sizeBytes: 4096n, withMedia: true });
    const candidate = await seed({ copyState: 'CANDIDATE', withMedia: false });
    const active = await seed({ copyState: 'HEALTHY', sizeBytes: 4096n, withMedia: true });
    await prisma.job.create({ data: { type: 'DOWNLOAD', status: 'RUNNING', videoId: active.id } });

    const res = await videos.deleteVideos(
      [healthy.id, candidate.id, active.id, 'nope404'],
      'reclaim',
    );
    expect(res.deleted).toEqual([healthy.id]);
    expect(res.freedBytes).toBe(4096); // only the fully-successful id counts
    expect(res.failed).toEqual([
      { videoId: candidate.id, reason: 'not_eligible' },
      { videoId: active.id, reason: 'active_job' },
      { videoId: 'nope404', reason: 'not_found' },
    ]);
  }, 60_000);
});
