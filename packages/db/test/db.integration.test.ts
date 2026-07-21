import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobStatus, JobType, LiveSessionState, PrismaClient, StatusAxis } from '../src/index.js';

const migrationsDir = fileURLToPath(new URL('../prisma/migrations', import.meta.url));

/** Apply Prisma migration SQL directly via pg (no CLI dependency at test time). */
async function applyMigrations(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const dirs = readdirSync(migrationsDir)
      .filter((d) => /^\d/.test(d))
      .sort();
    for (const dir of dirs) {
      const sql = readFileSync(path.join(migrationsDir, dir, 'migration.sql'), 'utf8');
      await client.query(sql);
    }
  } finally {
    await client.end();
  }
}

describe('db integration (Testcontainers + real Prisma)', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    const url = container.getConnectionUri();
    await applyMigrations(url);
    prisma = new PrismaClient({ datasourceUrl: url });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  /** Seed a Channel (idempotent) + a fresh Video under it. */
  async function seedVideo(channelId: string, videoId: string): Promise<void> {
    await prisma.channel.upsert({
      where: { id: channelId },
      create: {
        id: channelId,
        url: `https://www.youtube.com/channel/${channelId}`,
        title: `Channel ${channelId}`,
      },
      update: {},
    });
    await prisma.video.create({ data: { id: videoId, channelId, title: `Video ${videoId}` } });
  }

  it('round-trips BigInt sizeBytes exactly', async () => {
    await prisma.channel.create({
      data: {
        id: 'UCbigint000000000000000',
        url: 'https://www.youtube.com/channel/UCbigint000000000000000',
        title: 'BigInt Channel',
      },
    });
    await prisma.video.create({
      data: {
        id: 'vid-bigint',
        channelId: 'UCbigint000000000000000',
        title: 'Video vid-bigint',
        sizeBytes: 5_000_000_000n,
      },
    });

    const found = await prisma.video.findUnique({ where: { id: 'vid-bigint' } });
    expect(found?.sizeBytes).toBe(5_000_000_000n);
  });

  it('CR-09 migration: Video source-recheck columns default + round-trip; SOURCE_CHECK jobs persist', async () => {
    await seedVideo('UCcr090000000000000000', 'vid-cr09');

    // Defaults from the migration: streak 0, cadence cursors null.
    const fresh = await prisma.video.findUniqueOrThrow({ where: { id: 'vid-cr09' } });
    expect(fresh.sourceGoneStreak).toBe(0);
    expect(fresh.lastSourceCheckAt).toBeNull();
    expect(fresh.nextSourceCheckAt).toBeNull();

    const at = new Date('2026-07-08T12:00:00.000Z');
    const updated = await prisma.video.update({
      where: { id: 'vid-cr09' },
      data: {
        sourceState: 'DELETED',
        sourceGoneStreak: 2,
        lastSourceCheckAt: at,
        nextSourceCheckAt: at,
      },
    });
    expect(updated.sourceGoneStreak).toBe(2);
    expect(updated.sourceState).toBe('DELETED');
    expect(updated.nextSourceCheckAt).toEqual(at);

    // The new JobType enum value persists (AlterEnum applied).
    const job = await prisma.job.create({
      data: { type: JobType.SOURCE_CHECK, status: JobStatus.QUEUED, videoId: 'vid-cr09' },
    });
    expect(job.type).toBe(JobType.SOURCE_CHECK);
  });

  it('CR-14 migration: Video.description defaults null + round-trips a long body', async () => {
    await seedVideo('UCcr140000000000000000', 'vid-cr14');

    // Default from the migration: a freshly-created Video has no description.
    const fresh = await prisma.video.findUniqueOrThrow({ where: { id: 'vid-cr14' } });
    expect(fresh.description).toBeNull();

    const body =
      'Line one.\nLine two — unicode ✓ and a longer tail so TEXT (not varchar) is exercised.';
    const updated = await prisma.video.update({
      where: { id: 'vid-cr14' },
      data: { description: body },
    });
    expect(updated.description).toBe(body);
    const reread = await prisma.video.findUniqueOrThrow({ where: { id: 'vid-cr14' } });
    expect(reread.description).toBe(body);
  });

  it('ux_job_active_download: at most one active DOWNLOAD job per video', async () => {
    await seedVideo('UCjobs00000000000000000', 'vid-job');
    const first = await prisma.job.create({
      data: { type: JobType.DOWNLOAD, status: JobStatus.QUEUED, videoId: 'vid-job' },
    });

    // A second active DOWNLOAD job (RUNNING) for the same video must violate the
    // partial unique index. Prisma surfaces the PG unique violation as a rejection.
    await expect(
      prisma.job.create({
        data: { type: JobType.DOWNLOAD, status: JobStatus.RUNNING, videoId: 'vid-job' },
      }),
    ).rejects.toThrow();

    // A different job TYPE is allowed while a DOWNLOAD is active.
    await expect(
      prisma.job.create({
        data: { type: JobType.VERIFY, status: JobStatus.QUEUED, videoId: 'vid-job' },
      }),
    ).resolves.toMatchObject({ type: JobType.VERIFY });

    // Once the first job leaves the active set, a fresh DOWNLOAD job is allowed.
    await prisma.job.update({ where: { id: first.id }, data: { status: JobStatus.COMPLETED } });
    await expect(
      prisma.job.create({
        data: { type: JobType.DOWNLOAD, status: JobStatus.QUEUED, videoId: 'vid-job' },
      }),
    ).resolves.toMatchObject({ status: JobStatus.QUEUED });
  });

  it('ux_live_session_active: at most one active LiveSession per video', async () => {
    await seedVideo('UClive00000000000000000', 'vid-live');
    const first = await prisma.liveSession.create({
      data: {
        videoId: 'vid-live',
        channelId: 'UClive00000000000000000',
        state: LiveSessionState.DETECTED,
      },
    });

    await expect(
      prisma.liveSession.create({
        data: {
          videoId: 'vid-live',
          channelId: 'UClive00000000000000000',
          state: LiveSessionState.CAPTURING,
        },
      }),
    ).rejects.toThrow();

    // An ended session no longer blocks a new active one.
    await prisma.liveSession.update({
      where: { id: first.id },
      data: { state: LiveSessionState.ENDED_NORMAL },
    });
    await expect(
      prisma.liveSession.create({
        data: {
          videoId: 'vid-live',
          channelId: 'UClive00000000000000000',
          state: LiveSessionState.DETECTED,
        },
      }),
    ).resolves.toMatchObject({ state: LiveSessionState.DETECTED });
  });

  it('Settings singleton upsert works', async () => {
    const created = await prisma.settings.upsert({
      where: { id: 'singleton' },
      create: {},
      update: {},
    });
    expect(created.id).toBe('singleton');
    expect(created.downloadConcurrency).toBe(1);

    const updated = await prisma.settings.upsert({
      where: { id: 'singleton' },
      create: {},
      update: { downloadConcurrency: 3 },
    });
    expect(updated.downloadConcurrency).toBe(3);
    expect(await prisma.settings.count()).toBe(1);
  });

  it('deleting a Video cascades its Jobs and VideoStatusEvents', async () => {
    await seedVideo('UCcascade00000000000000', 'vid-cascade');
    await prisma.job.create({ data: { type: JobType.DOWNLOAD, videoId: 'vid-cascade' } });
    await prisma.videoStatusEvent.create({
      data: {
        videoId: 'vid-cascade',
        axis: StatusAxis.COPY,
        oldState: 'CANDIDATE',
        newState: 'QUEUED',
      },
    });

    await prisma.video.delete({ where: { id: 'vid-cascade' } });

    expect(await prisma.job.count({ where: { videoId: 'vid-cascade' } })).toBe(0);
    expect(await prisma.videoStatusEvent.count({ where: { videoId: 'vid-cascade' } })).toBe(0);
  });
});
