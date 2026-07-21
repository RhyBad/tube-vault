/**
 * CR-25 PublishedAtBackfill integration (pg testcontainer + a real LocalFileStore
 * on a temp vault + a fake VOD probe). Pins the owner-locked "disk-first, re-probe
 * only lives" repair of historical null-publishedAt rows:
 *
 *  - a regular download with an on-disk info.json → filled FROM DISK (no probe),
 *  - a LIVE row with no info.json → filled FROM the VOD re-PROBE,
 *  - an existing publishedAt is NEVER overwritten (updateMany WHERE null),
 *  - a second run only touches the still-null rows (idempotent),
 *  - a non-live row with no info.json, and a live whose probe returns null, are
 *    left null (skipped) — the probe is NOT called for non-live rows.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@tubevault/db';
import { LocalFileStore } from '@tubevault/storage';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PublishedAtBackfill, type VodPublishProbe } from './published-at-backfill';

const CHANNEL = 'UCbackfill0000000000000000';

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

/** A fake probe that records who it was asked about and answers from a fixed map. */
class FakeProbe implements VodPublishProbe {
  readonly asked: string[] = [];
  constructor(private readonly answers: Record<string, Date | null>) {}
  publishedAt(videoId: string): Promise<Date | null> {
    this.asked.push(videoId);
    return Promise.resolve(this.answers[videoId] ?? null);
  }
}

describe('PublishedAtBackfill (pg testcontainer + temp vault)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let vaultRoot: string;
  let store: LocalFileStore;
  let seq = 0;

  beforeAll(async () => {
    pgContainer = await new PostgreSqlContainer('postgres:17-alpine').start();
    await applyMigrations(pgContainer.getConnectionUri());
    prisma = new PrismaClient({ datasourceUrl: pgContainer.getConnectionUri() });
    vaultRoot = mkdtempSync(join(tmpdir(), 'tv-backfill-'));
    store = new LocalFileStore(vaultRoot);
    await prisma.channel.create({
      data: { id: CHANNEL, url: 'https://www.youtube.com/@backfill', title: 'Backfill channel' },
    });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pgContainer?.stop();
    if (vaultRoot) rmSync(vaultRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await prisma.video.deleteMany({ where: { channelId: CHANNEL } });
  });

  /** Seed a video row (default null publishedAt). */
  async function seed(opts: {
    contentType?: 'REGULAR' | 'LIVE';
    publishedAt?: Date | null;
    withInfoJson?: Record<string, unknown> | null;
  }): Promise<string> {
    seq += 1;
    const id = `bfvid${String(seq).padStart(5, '0')}`;
    await prisma.video.create({
      data: {
        id,
        channelId: CHANNEL,
        title: `Video ${id}`,
        contentType: opts.contentType ?? 'REGULAR',
        publishedAt: opts.publishedAt ?? null,
      },
    });
    if (opts.withInfoJson !== undefined && opts.withInfoJson !== null) {
      const paths = store.pathsFor(CHANNEL, id, `Video ${id}`);
      store.ensureDir(paths);
      writeFileSync(join(paths.directory, `${id}.info.json`), JSON.stringify(opts.withInfoJson));
    }
    return id;
  }

  it('fills a regular video FROM DISK and a live FROM PROBE; never calls the probe for a regular row', async () => {
    const regular = await seed({
      contentType: 'REGULAR',
      withInfoJson: { id: 'x', duration: 10, upload_date: '20240131', timestamp: 1700000000 },
    });
    const live = await seed({ contentType: 'LIVE', withInfoJson: null });

    const probe = new FakeProbe({ [live]: new Date('2024-02-02T00:00:00.000Z') });
    const report = await new PublishedAtBackfill(prisma, store, probe).run({ reprobeLives: true });

    expect(report).toEqual({ scanned: 2, filledFromDisk: 1, filledFromProbe: 1, skipped: 0 });

    const rv = await prisma.video.findUniqueOrThrow({ where: { id: regular } });
    expect(rv.publishedAt).toEqual(new Date(1700000000 * 1000)); // exact timestamp from disk
    const lv = await prisma.video.findUniqueOrThrow({ where: { id: live } });
    expect(lv.publishedAt).toEqual(new Date('2024-02-02T00:00:00.000Z')); // from the probe

    expect(probe.asked).toEqual([live]); // the regular row was filled from disk, never probed
  }, 60_000);

  it('NEVER overwrites an existing publishedAt (a row with a value is not even scanned)', async () => {
    const existing = new Date('2020-01-01T00:00:00.000Z');
    const kept = await seed({
      contentType: 'LIVE',
      publishedAt: existing,
      withInfoJson: { id: 'x', timestamp: 1700000000 },
    });

    const probe = new FakeProbe({ [kept]: new Date('2099-01-01T00:00:00.000Z') });
    const report = await new PublishedAtBackfill(prisma, store, probe).run();

    expect(report.scanned).toBe(0); // only null-publishedAt rows are examined
    const v = await prisma.video.findUniqueOrThrow({ where: { id: kept } });
    expect(v.publishedAt).toEqual(existing); // untouched
    expect(probe.asked).toEqual([]);
  }, 60_000);

  it('skips a non-live row with no info.json, and a live whose probe returns null; a re-run is a no-op', async () => {
    const orphanRegular = await seed({ contentType: 'REGULAR', withInfoJson: null });
    const unmeasurableLive = await seed({ contentType: 'LIVE', withInfoJson: null });

    const probe = new FakeProbe({ [unmeasurableLive]: null }); // probe can't measure it yet
    const first = await new PublishedAtBackfill(prisma, store, probe).run();
    expect(first).toEqual({ scanned: 2, filledFromDisk: 0, filledFromProbe: 0, skipped: 2 });
    expect(probe.asked).toEqual([unmeasurableLive]); // non-live NOT probed

    // both still null → a second run re-scans exactly the same 2 rows (idempotent)
    const second = await new PublishedAtBackfill(prisma, store, probe).run();
    expect(second.scanned).toBe(2);
    expect(
      (await prisma.video.findUniqueOrThrow({ where: { id: orphanRegular } })).publishedAt,
    ).toBeNull();
  }, 60_000);

  it('reprobeLives=false leaves lives untouched (disk-only pass)', async () => {
    const live = await seed({ contentType: 'LIVE', withInfoJson: null });
    const probe = new FakeProbe({ [live]: new Date('2024-02-02T00:00:00.000Z') });

    const report = await new PublishedAtBackfill(prisma, store, probe).run({ reprobeLives: false });

    expect(report).toEqual({ scanned: 1, filledFromDisk: 0, filledFromProbe: 0, skipped: 1 });
    expect(probe.asked).toEqual([]); // no probe when re-probe is disabled
  }, 60_000);
});
