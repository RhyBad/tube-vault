/**
 * CR-24 backfill migration (6_backfill_live_contenttype) — pg Testcontainer.
 *
 * The forward fix (markContentTypeLive at detection + capture-start) is
 * forward-only, so lives that were already mistagged contentType=REGULAR before
 * the fix stay invisible in every `contentType=LIVE` surface. This migration
 * repairs them: a video with a LiveSession IS a live. The test drives the ACTUAL
 * migration SQL (read off disk, idempotent) against a seeded matrix to pin its
 * precision — it must flip ONLY REGULAR-with-a-session and touch nothing else.
 */
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../src/index.js';

const migrationsDir = fileURLToPath(new URL('../prisma/migrations', import.meta.url));

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

/** The migration under test — re-run (idempotent) against seeded rows. */
const BACKFILL_SQL = readFileSync(
  path.join(migrationsDir, '6_backfill_live_contenttype', 'migration.sql'),
  'utf8',
);

const CH = 'UCbackfill0000000000000';

describe('CR-24 backfill: REGULAR + LiveSession → LIVE (6_backfill_live_contenttype)', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    const url = container.getConnectionUri();
    await applyMigrations(url); // includes migration 6 (a no-op on the empty DB)
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.channel.create({
      data: { id: CH, url: 'https://www.youtube.com/@backfill', title: 'Backfill' },
    });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  async function seedVideo(
    id: string,
    contentType: 'REGULAR' | 'LIVE' | 'SHORTS',
    withSession: boolean,
  ): Promise<void> {
    await prisma.video.create({ data: { id, channelId: CH, title: id, contentType } });
    if (withSession) {
      await prisma.liveSession.create({
        data: { videoId: id, channelId: CH, state: 'ENDED_INTERRUPTED' },
      });
    }
  }

  it('flips ONLY REGULAR videos that have a LiveSession; leaves everything else', async () => {
    await seedVideo('bf-regular-session', 'REGULAR', true); // the mistag → repaired
    await seedVideo('bf-regular-nosession', 'REGULAR', false); // no session → untouched
    await seedVideo('bf-live-session', 'LIVE', true); // already correct
    await seedVideo('bf-shorts-session', 'SHORTS', true); // not REGULAR → untouched

    // Drive the ACTUAL migration SQL (idempotent) against the seeded rows.
    await prisma.$executeRawUnsafe(BACKFILL_SQL);

    const ct = async (id: string): Promise<string> =>
      (await prisma.video.findUniqueOrThrow({ where: { id } })).contentType;

    expect(await ct('bf-regular-session')).toBe('LIVE'); // repaired
    expect(await ct('bf-regular-nosession')).toBe('REGULAR'); // no session — untouched
    expect(await ct('bf-live-session')).toBe('LIVE'); // already LIVE
    expect(await ct('bf-shorts-session')).toBe('SHORTS'); // not REGULAR — untouched
  }, 60_000);
});
