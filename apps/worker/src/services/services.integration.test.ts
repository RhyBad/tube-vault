/**
 * VideoStateService + NotificationsService over a real Testcontainers Postgres.
 *
 * The copy-state TRAIL is a headline P6 target: every transition must be a
 * guarded CAS + a VideoStatusEvent row in the SAME transaction + a
 * `video:changed` publish. The notification dedupe ports v1
 * `notify_dispatch.py`'s 6h debounce window (v2 refinement: only UNDISMISSED
 * rows suppress — dismissing an alert re-arms it).
 */
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { IllegalTransitionError } from '@tubevault/core';
import { PrismaClient } from '@tubevault/db';
import { REDIS_CHANNEL_VIDEO_CHANGED } from '@tubevault/types';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { RedisPublisher } from '../redis-publisher';
import { NotificationsService } from './notifications.service';
import { VideoStateService } from './video-state.service';

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

/** Captures publishes instead of talking to Redis (unit seam; never throws). */
class FakePublisher {
  readonly published: { channel: string; payload: unknown }[] = [];
  async publish(channel: string, payload: unknown): Promise<void> {
    this.published.push({ channel, payload });
  }
}

const CHANNEL = 'UCservicechannel00000000';

describe('VideoStateService + NotificationsService (pg testcontainer)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let publisher: FakePublisher;
  let videoState: VideoStateService;
  let notifications: NotificationsService;

  beforeAll(async () => {
    pgContainer = await new PostgreSqlContainer('postgres:17-alpine').start();
    await applyMigrations(pgContainer.getConnectionUri());
    prisma = new PrismaClient({ datasourceUrl: pgContainer.getConnectionUri() });
    await prisma.channel.create({
      data: { id: CHANNEL, url: 'https://www.youtube.com/@svc', title: 'Service channel' },
    });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pgContainer?.stop();
  });

  beforeEach(() => {
    publisher = new FakePublisher();
    videoState = new VideoStateService(prisma, publisher as unknown as RedisPublisher);
    notifications = new NotificationsService(prisma);
  });

  async function seedVideo(id: string, copyState: 'CANDIDATE' | 'QUEUED' = 'CANDIDATE') {
    return prisma.video.create({
      data: { id, channelId: CHANNEL, title: `video ${id}`, copyState },
    });
  }

  describe('VideoStateService.transitionCopy', () => {
    it('legal hop: updates copyState, appends the COPY event, bumps updatedAt, publishes video:changed', async () => {
      const before = await seedVideo('svcvid0001');
      const ok = await videoState.transitionCopy(
        'svcvid0001',
        'CANDIDATE',
        'QUEUED',
        'enqueued by test',
      );
      expect(ok).toBe(true);

      const after = await prisma.video.findUniqueOrThrow({ where: { id: 'svcvid0001' } });
      expect(after.copyState).toBe('QUEUED');
      expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());

      const events = await prisma.videoStatusEvent.findMany({ where: { videoId: 'svcvid0001' } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        axis: 'COPY',
        oldState: 'CANDIDATE',
        newState: 'QUEUED',
        note: 'enqueued by test',
      });

      expect(publisher.published).toEqual([
        {
          channel: REDIS_CHANNEL_VIDEO_CHANGED,
          payload: {
            videoId: 'svcvid0001',
            channelId: CHANNEL,
            copyState: 'QUEUED',
            sourceState: 'UNKNOWN',
          },
        },
      ]);
    });

    it('ILLEGAL hop throws IllegalTransitionError and leaves the row + trail untouched', async () => {
      await seedVideo('svcvid0002'); // CANDIDATE
      await expect(videoState.transitionCopy('svcvid0002', 'CANDIDATE', 'HEALTHY')).rejects.toThrow(
        IllegalTransitionError,
      );
      const after = await prisma.video.findUniqueOrThrow({ where: { id: 'svcvid0002' } });
      expect(after.copyState).toBe('CANDIDATE');
      expect(await prisma.videoStatusEvent.count({ where: { videoId: 'svcvid0002' } })).toBe(0);
      expect(publisher.published).toEqual([]);
    });

    it('missing video → false, no event, no publish (CAS semantics)', async () => {
      expect(await videoState.transitionCopy('doesnotexist', 'CANDIDATE', 'QUEUED')).toBe(false);
      expect(publisher.published).toEqual([]);
    });

    it('expectedFrom CAS: a stale writer whose expectedFrom no longer matches gets FALSE and writes NOTHING (even when the hop is table-legal from the CURRENT state)', async () => {
      // The TOCTOU killer: the video moved DOWNLOADING→VERIFYING under a racer;
      // the racer's belated DOWNLOADING→FAILED must NOT be applied just because
      // VERIFYING→FAILED happens to be table-legal too.
      await prisma.video.create({
        data: {
          id: 'svcvid0005',
          channelId: CHANNEL,
          title: 'video svcvid0005',
          copyState: 'VERIFYING',
        },
      });
      const ok = await videoState.transitionCopy('svcvid0005', 'DOWNLOADING', 'FAILED', 'stale');
      expect(ok).toBe(false);
      const after = await prisma.video.findUniqueOrThrow({ where: { id: 'svcvid0005' } });
      expect(after.copyState).toBe('VERIFYING'); // untouched
      expect(await prisma.videoStatusEvent.count({ where: { videoId: 'svcvid0005' } })).toBe(0);
      expect(publisher.published).toEqual([]);
    });

    it('atomic patch: extra Video scalars land WITH the transition; a CAS-lost transition writes NONE of them', async () => {
      await prisma.video.create({
        data: {
          id: 'svcvid0006',
          channelId: CHANNEL,
          title: 'video svcvid0006',
          copyState: 'DOWNLOADING',
        },
      });
      const ok = await videoState.transitionCopy('svcvid0006', 'DOWNLOADING', 'VERIFYING', '', {
        mediaExt: 'mp4',
        sizeBytes: 2048n,
        sourceDurationSeconds: 12.5,
      });
      expect(ok).toBe(true);
      const after = await prisma.video.findUniqueOrThrow({ where: { id: 'svcvid0006' } });
      expect(after.copyState).toBe('VERIFYING');
      expect(after.mediaExt).toBe('mp4');
      expect(after.sizeBytes).toBe(2048n);
      expect(after.sourceDurationSeconds).toBe(12.5);

      // CAS lost (video already FAILED) → the patch must not leak through.
      await prisma.video.create({
        data: {
          id: 'svcvid0007',
          channelId: CHANNEL,
          title: 'video svcvid0007',
          copyState: 'FAILED',
        },
      });
      const lost = await videoState.transitionCopy('svcvid0007', 'DOWNLOADING', 'VERIFYING', '', {
        mediaExt: 'mp4',
      });
      expect(lost).toBe(false);
      const untouched = await prisma.video.findUniqueOrThrow({ where: { id: 'svcvid0007' } });
      expect(untouched.copyState).toBe('FAILED');
      expect(untouched.mediaExt).toBeNull(); // nothing from the losing write
    });

    it('the v2 cancel transitions are wired: QUEUED→CANDIDATE and DOWNLOADING→CANDIDATE', async () => {
      await seedVideo('svcvid0003', 'QUEUED');
      expect(await videoState.transitionCopy('svcvid0003', 'QUEUED', 'CANDIDATE', 'canceled')).toBe(
        true,
      );
      expect(await videoState.transitionCopy('svcvid0003', 'CANDIDATE', 'QUEUED')).toBe(true);
      expect(await videoState.transitionCopy('svcvid0003', 'QUEUED', 'DOWNLOADING')).toBe(true);
      expect(
        await videoState.transitionCopy('svcvid0003', 'DOWNLOADING', 'CANDIDATE', 'canceled'),
      ).toBe(true);
      const trail = await prisma.videoStatusEvent.findMany({
        where: { videoId: 'svcvid0003' },
        orderBy: { at: 'asc' },
      });
      expect(trail.map((e) => `${e.oldState}>${e.newState}`)).toEqual([
        'QUEUED>CANDIDATE',
        'CANDIDATE>QUEUED',
        'QUEUED>DOWNLOADING',
        'DOWNLOADING>CANDIDATE',
      ]);
    });
  });

  describe('VideoStateService.markContentTypeLive (CR-24)', () => {
    it('a REGULAR video → contentType LIVE, publishes video:changed (badge), NO status event', async () => {
      await seedVideo('svcvid0100'); // REGULAR (schema default), CANDIDATE
      const changed = await videoState.markContentTypeLive('svcvid0100');
      expect(changed).toBe(true);

      const after = await prisma.video.findUniqueOrThrow({ where: { id: 'svcvid0100' } });
      expect(after.contentType).toBe('LIVE');
      // contentType is not a tracked axis — no VideoStatusEvent is written.
      expect(await prisma.videoStatusEvent.count({ where: { videoId: 'svcvid0100' } })).toBe(0);
      expect(publisher.published).toEqual([
        {
          channel: REDIS_CHANNEL_VIDEO_CHANGED,
          payload: {
            videoId: 'svcvid0100',
            channelId: CHANNEL,
            copyState: 'CANDIDATE',
            sourceState: 'UNKNOWN',
          },
        },
      ]);
    });

    it('already LIVE → idempotent no-op: FALSE, nothing published', async () => {
      await prisma.video.create({
        data: { id: 'svcvid0101', channelId: CHANNEL, title: 'v', contentType: 'LIVE' },
      });
      expect(await videoState.markContentTypeLive('svcvid0101')).toBe(false);
      expect(publisher.published).toEqual([]);
    });

    it('missing video → FALSE, nothing published (CAS semantics)', async () => {
      expect(await videoState.markContentTypeLive('doesnotexist')).toBe(false);
      expect(publisher.published).toEqual([]);
    });
  });

  describe('NotificationsService.emit (v1 notify_dispatch 6h debounce)', () => {
    it('inserts a row, then DEBOUNCES the same dedupeKey inside the window', async () => {
      const first = await notifications.emit({
        type: 'youtube.bot_wall',
        severity: 'WARNING',
        title: 't',
        body: 'b',
        dedupeKey: 'debounce-test-1',
      });
      expect(first).toBe(true);
      const second = await notifications.emit({
        type: 'youtube.bot_wall',
        severity: 'WARNING',
        title: 't',
        body: 'b',
        dedupeKey: 'debounce-test-1',
      });
      expect(second).toBe(false); // suppressed
      expect(await prisma.notification.count({ where: { dedupeKey: 'debounce-test-1' } })).toBe(1);
    });

    it('a row OLDER than the 6h window does not suppress', async () => {
      await prisma.notification.create({
        data: {
          type: 'x',
          severity: 'WARNING',
          title: 't',
          body: 'b',
          dedupeKey: 'debounce-test-2',
          createdAt: new Date(Date.now() - 7 * 60 * 60 * 1000), // 7h ago
        },
      });
      expect(
        await notifications.emit({
          type: 'x',
          severity: 'WARNING',
          title: 't',
          body: 'b',
          dedupeKey: 'debounce-test-2',
        }),
      ).toBe(true);
    });

    it('a DISMISSED row does not suppress (dismissing re-arms the alert)', async () => {
      await prisma.notification.create({
        data: {
          type: 'x',
          severity: 'WARNING',
          title: 't',
          body: 'b',
          dedupeKey: 'debounce-test-3',
          dismissedAt: new Date(),
        },
      });
      expect(
        await notifications.emit({
          type: 'x',
          severity: 'WARNING',
          title: 't',
          body: 'b',
          dedupeKey: 'debounce-test-3',
        }),
      ).toBe(true);
    });

    it('no dedupeKey → always inserted', async () => {
      expect(await notifications.emit({ type: 'x', severity: 'INFO', title: 'a', body: '1' })).toBe(
        true,
      );
      expect(await notifications.emit({ type: 'x', severity: 'INFO', title: 'a', body: '1' })).toBe(
        true,
      );
    });

    it('CONCURRENT same-key emits are serialized: exactly one row per key (advisory-lock dedupe)', async () => {
      // Under downloadConcurrency 4 two terminal failures can both pass the
      // findFirst window check before either inserts (TOCTOU) → duplicate rows.
      for (let round = 0; round < 10; round++) {
        const dedupeKey = `race-key-${round}`;
        const results = await Promise.all(
          Array.from({ length: 4 }, () =>
            notifications.emit({
              type: 'youtube.bot_wall',
              severity: 'WARNING',
              title: 't',
              body: 'b',
              dedupeKey,
            }),
          ),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(await prisma.notification.count({ where: { dedupeKey } })).toBe(1);
      }
    });

    it('emitDownloadFailed keys the dedupe on the video status-event COUNT (per occurrence)', async () => {
      await seedVideo('svcvid0004', 'QUEUED');
      await videoState.transitionCopy('svcvid0004', 'QUEUED', 'DOWNLOADING'); // 1 event
      await notifications.emitDownloadFailed(
        { id: 'svcvid0004', channelId: CHANNEL, title: 'video svcvid0004' },
        'download failed: boom',
      );
      const rows = await prisma.notification.findMany({ where: { videoId: 'svcvid0004' } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: 'download.failed',
        severity: 'WARNING',
        title: 'Download failed: video svcvid0004',
        body: 'download failed: boom',
        channelId: CHANNEL,
        dedupeKey: 'download.failed:svcvid0004:1',
      });
    });
  });
});
