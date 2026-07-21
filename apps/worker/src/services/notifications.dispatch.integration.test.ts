/**
 * P8 external dispatch wiring: NotificationsService.emit() fans a REAL insert
 * out to the enabled NotificationChannel rows via @tubevault/notify — over a
 * real Postgres and a LOCAL node:http receiver (the wire-level realism leg).
 *
 * The dedupe-window requirement is satisfied structurally: dispatch fires ONLY
 * on real inserts, so a debounced emission delivers nothing — asserted here
 * DETERMINISTICALLY via the settleExternalDispatches() test seam (no fixed
 * observation windows, per the established flake discipline).
 */
import * as http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@tubevault/db';
import { redact } from '@tubevault/engine';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { downloadFailedAlert, sourceGoneAlert, videoRescuedAlert } from './alerts';
import { NotificationsService } from './notifications.service';

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

interface ReceivedRequest {
  url: string;
  body: string;
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`condition not met within ${ms}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('NotificationsService external dispatch (pg testcontainer + local http receiver)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let service: NotificationsService;
  let receiver: http.Server;
  let receiverBase: string;
  const received: ReceivedRequest[] = [];
  // Response gate: with holdResponses the receiver RECORDS the request but
  // answers only on releaseHeld() — the deterministic in-flight window for the
  // fire-and-forget latency pin and the shutdown-drain test (no sleeps).
  let holdResponses = false;
  const heldResponses: http.ServerResponse[] = [];

  function releaseHeld(): void {
    for (const res of heldResponses.splice(0)) {
      res.statusCode = 200;
      res.end('{}');
    }
  }

  beforeAll(async () => {
    pgContainer = await new PostgreSqlContainer('postgres:17-alpine').start();
    await applyMigrations(pgContainer.getConnectionUri());
    prisma = new PrismaClient({ datasourceUrl: pgContainer.getConnectionUri() });
    service = new NotificationsService(prisma);

    receiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        received.push({ url: req.url ?? '', body });
        if (holdResponses) {
          heldResponses.push(res); // gated: answered by releaseHeld()
          return;
        }
        res.statusCode = 200;
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => {
      receiver.listen(0, '127.0.0.1', resolve);
    });
    receiverBase = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await new Promise<void>((resolve) => {
      receiver?.close(() => {
        resolve();
      });
    });
    await pgContainer?.stop();
  });

  beforeEach(async () => {
    received.length = 0;
    holdResponses = false;
    releaseHeld(); // never leak a gated response into the next test
    await prisma.notification.deleteMany({});
    await prisma.notificationChannel.deleteMany({});
  });

  async function seedChannel(overrides: {
    path: string;
    events?: string[];
    minSeverity?: 'INFO' | 'WARNING' | 'CRITICAL';
    enabled?: boolean;
  }): Promise<void> {
    await prisma.notificationChannel.create({
      data: {
        type: 'WEBHOOK',
        name: `hook ${overrides.path}`,
        config: { url: `${receiverBase}${overrides.path}` },
        events: overrides.events ?? ['download.failed', 'youtube.bot_wall', 'session.expired'],
        minSeverity: overrides.minSeverity ?? 'INFO',
        enabled: overrides.enabled ?? true,
      },
    });
  }

  const video = { id: 'dispvid0001', channelId: 'UCdisp', title: 'Dispatch Me' };

  it('a real insert delivers the EXACT v1-shape payload — with the STORED row timestamp, not a re-stamped now', async () => {
    await seedChannel({ path: '/wanted' });
    const inserted = await service.emit(downloadFailedAlert(video, 'download failed: boom', 3));
    expect(inserted).toBe(true);
    await service.settleExternalDispatches();

    expect(received).toHaveLength(1);
    expect(received[0]!.url).toBe('/wanted');
    const row = await prisma.notification.findFirstOrThrow({
      where: { dedupeKey: 'download.failed:dispvid0001:3' },
    });
    const payload = JSON.parse(received[0]!.body) as Record<string, unknown>;
    // EXACT deep-equal (not toMatchObject): an extra/leaked field must fail.
    // `at` is the inserted Notification row's createdAt (v1 delivered the
    // stored event's timestamp) — the in-app record and the wire agree.
    expect(payload).toEqual({
      type: 'download.failed',
      severity: 'warning', // v1 lowercase wire severity
      at: row.createdAt.toISOString(),
      title: 'Download failed: Dispatch Me',
      body: 'download failed: boom',
      videoId: 'dispvid0001',
      channelId: 'UCdisp',
      dedupeKey: 'download.failed:dispvid0001:3',
    });
  });

  it('CR-09: source.gone and video.rescued reach a channel subscribed to them', async () => {
    await seedChannel({ path: '/cr09', events: ['source.gone', 'video.rescued'] });
    expect(await service.emit(videoRescuedAlert(video))).toBe(true);
    expect(await service.emit(sourceGoneAlert(video))).toBe(true);
    await service.settleExternalDispatches();

    const types = received.map((r) => (JSON.parse(r.body) as { type: string }).type).sort();
    expect(types).toEqual(['source.gone', 'video.rescued']);
    const rescued = received.find((r) => r.body.includes('video.rescued'))!;
    const payload = JSON.parse(rescued.body) as Record<string, unknown>;
    expect(payload.severity).toBe('info'); // video.rescued is INFO
    expect(payload.videoId).toBe('dispvid0001');
  });

  it('a DEBOUNCED second emission delivers NOTHING (dispatch only on real inserts)', async () => {
    await seedChannel({ path: '/dedupe' });
    const first = await service.emit(downloadFailedAlert(video, 'boom', 7));
    const second = await service.emit(downloadFailedAlert(video, 'boom', 7)); // same dedupe key
    await service.settleExternalDispatches();
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(received).toHaveLength(1);
  });

  it('channel filters are respected: disabled / wrong event / too-low severity get nothing', async () => {
    await seedChannel({ path: '/yes' });
    await seedChannel({ path: '/disabled', enabled: false });
    await seedChannel({ path: '/wrong-events', events: ['live.start'] });
    await seedChannel({ path: '/too-low', minSeverity: 'CRITICAL' });
    await service.emit(downloadFailedAlert(video, 'boom', 9));
    await service.settleExternalDispatches();
    expect(received.map((r) => r.url)).toEqual(['/yes']);
  });

  it('emit() resolves while the send is STILL IN FLIGHT (fire-and-forget latency pin), then delivers exactly once', async () => {
    await seedChannel({ path: '/gated-latency' });
    holdResponses = true;
    // The gate is NOT released before this await settles: if emit awaited
    // delivery it would park here until the 10s send abort — the latency
    // property is pinned by construction, not by a timing window.
    const inserted = await service.emit(downloadFailedAlert(video, 'boom', 11));
    expect(inserted).toBe(true);
    // The request arrives (dispatch is running) while its response stays gated.
    await until(() => received.some((r) => r.url === '/gated-latency'));
    expect(heldResponses.length).toBeGreaterThan(0); // emit settled BEFORE the response existed
    releaseHeld();
    await service.settleExternalDispatches();
    expect(received.filter((r) => r.url === '/gated-latency')).toHaveLength(1); // exactly once
  });

  it('onApplicationShutdown DRAINS in-flight dispatches (bounded by the per-send 10s abort) instead of dropping them', async () => {
    await seedChannel({ path: '/gated-drain' });
    holdResponses = true;
    await service.emit(downloadFailedAlert(video, 'boom', 15));
    await until(() => heldResponses.length === 1); // the send is in flight, response gated

    let drained = false;
    const drain = service.onApplicationShutdown().then(() => {
      drained = true;
    });
    // One macrotask is enough: a no-op/immediate shutdown would have resolved
    // by now (microtask), while a REAL drain cannot — the fetch has no response.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(drained).toBe(false);
    releaseHeld();
    await drain;
    expect(drained).toBe(true);
    expect(received.filter((r) => r.url === '/gated-drain')).toHaveLength(1); // delivered, not lost
  });

  it('registers channel secrets for redaction BEFORE dispatching (v1 defense-in-depth parity)', async () => {
    // The worker is a separate process from the api (fresh redaction registry),
    // so the dispatch path must register the secret config fields itself.
    const secretUrl = `${receiverBase}/hook-secret-token-abcdef123456`;
    await prisma.notificationChannel.create({
      data: {
        type: 'WEBHOOK',
        name: 'secret hook',
        config: { url: secretUrl },
        events: ['download.failed'],
        minSeverity: 'INFO',
        enabled: true,
      },
    });
    await service.emit(downloadFailedAlert(video, 'boom', 19));
    await service.settleExternalDispatches();
    const swept = redact(`dispatch to ${secretUrl} failed: ECONNREFUSED`);
    expect(swept).not.toContain('hook-secret-token-abcdef123456');
    expect(swept).toContain('***REDACTED***');
  });
});
