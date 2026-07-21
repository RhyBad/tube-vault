/**
 * P8 notification-channel CRUD + test-send + in-app notification center e2e
 * over the REAL Nest app (AppModule, global guard) + Testcontainers pg/redis.
 *
 * The test-send suite runs against a LOCAL node:http receiver — the realism
 * leg for @tubevault/notify: the EXACT v1 payloads/headers must arrive on the
 * wire. Secrets (botToken/appToken/accessToken/webhookUrl/url) must NEVER be
 * echoed by any endpoint (full '***' mask), and the PATCH keep-secret
 * semantics must preserve stored values.
 */
import * as http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hash } from '@node-rs/argon2';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@tubevault/db';
import {
  NOTIFICATION_EVENT_TYPES,
  type BulkDismissNotificationsResponse,
  type DismissAllNotificationsResponse,
  type NotificationChannelDto,
  type NotificationChannelListResponse,
  type NotificationListResponse,
  type TestNotificationChannelResponse,
} from '@tubevault/types';
import pg from 'pg';
import request from 'supertest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app-setup';

const SECRET = 'correct-horse-battery-staple';
const SESSION_KEY = 'k'.repeat(48);
const BOT_TOKEN = '7000000001:secret-telegram-bot-token';
const APP_TOKEN = 'gotify-secret-app-token-123';

const migrationsDir = fileURLToPath(
  new URL('../../../packages/db/prisma/migrations', import.meta.url),
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
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe('notification channels + center e2e (P8, real Nest app over pg + redis)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let app: INestApplication;
  let prisma: PrismaClient;
  let cookie: string;
  let receiver: http.Server;
  let receiverBase: string;
  let receiverStatus = 200;
  const received: ReceivedRequest[] = [];

  beforeAll(async () => {
    [pgContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:17-alpine').start(),
      new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    ]);
    await applyMigrations(pgContainer.getConnectionUri());

    process.env['DATABASE_URL'] = pgContainer.getConnectionUri();
    process.env['REDIS_HOST'] = redisContainer.getHost();
    process.env['REDIS_PORT'] = String(redisContainer.getMappedPort(6379));
    process.env['TUBEVAULT_ACCESS_SECRET_HASH'] = await hash(SECRET);
    process.env['TUBEVAULT_SESSION_KEY'] = SESSION_KEY;
    delete process.env['TUBEVAULT_CREDENTIAL_KEY_FILE'];

    prisma = new PrismaClient({ datasourceUrl: pgContainer.getConnectionUri() });

    receiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        received.push({ url: req.url ?? '', headers: req.headers, body });
        res.statusCode = receiverStatus;
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => {
      receiver.listen(0, '127.0.0.1', resolve);
    });
    receiverBase = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app); // the SHARED prod stack — no more test/prod middleware drift
    await app.init();

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ secret: SECRET })
      .expect(200);
    cookie = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await new Promise<void>((resolve) => {
      receiver?.close(() => {
        resolve();
      });
    });
    await Promise.all([pgContainer?.stop(), redisContainer?.stop()]);
  });

  // ------------------------------------------------------------------ guard --
  it('every notification endpoint is 401 JSON without a session cookie', async () => {
    const server = app.getHttpServer();
    await request(server).get('/api/notification-channels').expect(401);
    await request(server).post('/api/notification-channels').send({}).expect(401);
    await request(server).patch('/api/notification-channels/x').send({}).expect(401);
    await request(server).delete('/api/notification-channels/x').expect(401);
    await request(server).post('/api/notification-channels/x/test').expect(401);
    await request(server).get('/api/notifications').expect(401);
    await request(server).post('/api/notifications/x/dismiss').expect(401);
    await request(server).post('/api/notifications/dismiss-all').expect(401);
    await request(server).post('/api/notifications/dismiss').send({}).expect(401);
  });

  // ------------------------------------------------------------------- CRUD --
  describe('notification-channel CRUD', () => {
    let telegramId: string;

    it('POST creates a telegram channel: 201, secrets MASKED, events default to ALL types', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/notification-channels')
        .set('Cookie', cookie)
        .send({
          type: 'TELEGRAM',
          name: 'owner telegram',
          config: { botToken: BOT_TOKEN, chatId: '4242' },
        })
        .expect(201);
      const dto = res.body as NotificationChannelDto;
      telegramId = dto.id;
      expect(dto).toMatchObject({
        type: 'TELEGRAM',
        name: 'owner telegram',
        config: { botToken: '***', chatId: '4242' }, // full mask, non-secrets visible
        minSeverity: 'INFO',
        enabled: true,
      });
      expect([...dto.events].sort()).toEqual([...NOTIFICATION_EVENT_TYPES].sort());
      expect(JSON.stringify(res.body)).not.toContain(BOT_TOKEN);

      // The DB row keeps the REAL secret (masking is a read-side DTO concern).
      const row = await prisma.notificationChannel.findUniqueOrThrow({ where: { id: dto.id } });
      expect((row.config as { botToken: string }).botToken).toBe(BOT_TOKEN);
    });

    it('GET after POST: the listing is masked too', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/notification-channels')
        .set('Cookie', cookie)
        .expect(200);
      const body = res.body as NotificationChannelListResponse;
      const tg = body.channels.find((c) => c.id === telegramId);
      expect(tg?.config).toEqual({ botToken: '***', chatId: '4242' });
      expect(JSON.stringify(res.body)).not.toContain(BOT_TOKEN);
    });

    it('PATCH keep-secret: an omitted or literal-mask botToken keeps the stored value', async () => {
      // Round-trip a GET response shape: config carries the mask.
      const res = await request(app.getHttpServer())
        .patch(`/api/notification-channels/${telegramId}`)
        .set('Cookie', cookie)
        .send({ name: 'renamed tg', config: { botToken: '***', chatId: '5353' } })
        .expect(200);
      expect((res.body as NotificationChannelDto).config).toEqual({
        botToken: '***',
        chatId: '5353',
      });
      let row = await prisma.notificationChannel.findUniqueOrThrow({ where: { id: telegramId } });
      expect((row.config as { botToken: string }).botToken).toBe(BOT_TOKEN); // kept
      expect((row.config as { chatId: string }).chatId).toBe('5353');
      expect(row.name).toBe('renamed tg');

      // Omitting the secret entirely (merge onto stored) also keeps it.
      await request(app.getHttpServer())
        .patch(`/api/notification-channels/${telegramId}`)
        .set('Cookie', cookie)
        .send({ config: { chatId: '6464' } })
        .expect(200);
      row = await prisma.notificationChannel.findUniqueOrThrow({ where: { id: telegramId } });
      expect((row.config as { botToken: string }).botToken).toBe(BOT_TOKEN);
      expect((row.config as { chatId: string }).chatId).toBe('6464');

      // A REAL new secret value replaces the stored one (Bot-API token shape:
      // the config schema validates the <digits>:<token> pattern).
      await request(app.getHttpServer())
        .patch(`/api/notification-channels/${telegramId}`)
        .set('Cookie', cookie)
        .send({ config: { botToken: '8000000002:AAnew-token_000111' } })
        .expect(200);
      row = await prisma.notificationChannel.findUniqueOrThrow({ where: { id: telegramId } });
      expect((row.config as { botToken: string }).botToken).toBe('8000000002:AAnew-token_000111');
    });

    it('telegram botToken with URL/path metacharacters → 400 (the token is embedded in the API URL path)', async () => {
      const server = app.getHttpServer();
      // '/' would allow path injection into telegramApiUrl; '?' and '#' would
      // truncate/redirect the request. The <digits>:<base64url-ish> Bot-API
      // shape blocks them all at input.
      for (const botToken of [
        '7000000001:abc/../def',
        '7000000001:abc?x=1',
        '7000000001:abc#frag',
        'no-digits-prefix',
      ]) {
        await request(server)
          .post('/api/notification-channels')
          .set('Cookie', cookie)
          .send({ type: 'TELEGRAM', name: 'x', config: { botToken, chatId: '1' } })
          .expect(400);
      }
    });

    it('PATCH events/minSeverity/enabled; unknown event strings → 400', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/notification-channels/${telegramId}`)
        .set('Cookie', cookie)
        .send({ events: ['download.failed'], minSeverity: 'CRITICAL', enabled: false })
        .expect(200);
      expect(res.body as NotificationChannelDto).toMatchObject({
        events: ['download.failed'],
        minSeverity: 'CRITICAL',
        enabled: false,
      });
      await request(app.getHttpServer())
        .patch(`/api/notification-channels/${telegramId}`)
        .set('Cookie', cookie)
        .send({ events: ['made.up'] })
        .expect(400);
      await request(app.getHttpServer())
        .patch(`/api/notification-channels/${telegramId}`)
        .set('Cookie', cookie)
        .send({ minSeverity: 'LOUD' })
        .expect(400);
    });

    it('type is immutable on PATCH → 400', async () => {
      await request(app.getHttpServer())
        .patch(`/api/notification-channels/${telegramId}`)
        .set('Cookie', cookie)
        .send({ type: 'DISCORD' })
        .expect(400);
    });

    it('per-type config validation on POST: missing/invalid fields → 400, unknown type → 400', async () => {
      const server = app.getHttpServer();
      const cases: unknown[] = [
        { type: 'TELEGRAM', name: 'x', config: { chatId: 'only' } }, // missing botToken
        { type: 'DISCORD', name: 'x', config: { webhookUrl: 'not-a-url' } },
        { type: 'GOTIFY', name: 'x', config: { serverUrl: 'https://g.example' } }, // missing appToken
        { type: 'NTFY', name: 'x', config: { serverUrl: 'https://n.example' } }, // missing topic
        { type: 'WEBHOOK', name: 'x', config: {} }, // missing url
        { type: 'SMTP', name: 'x', config: { host: 'mail.example' } }, // v1 type, out of v2 scope
        { type: 'TELEGRAM', name: '', config: { botToken: 't'.repeat(10), chatId: '1' } },
        {
          type: 'TELEGRAM',
          name: 'y'.repeat(101),
          config: { botToken: 't'.repeat(10), chatId: '1' },
        },
        {
          type: 'TELEGRAM',
          name: 'x',
          config: { botToken: 'tttttt', chatId: '1' },
          events: ['nope'],
        },
      ];
      for (const body of cases) {
        await request(server)
          .post('/api/notification-channels')
          .set('Cookie', cookie)
          .send(body as object)
          .expect(400);
      }
    });

    it('DELETE removes the channel; PATCH/DELETE/test on a missing id → 404', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/notification-channels')
        .set('Cookie', cookie)
        .send({ type: 'WEBHOOK', name: 'doomed', config: { url: 'https://x.example/hook' } })
        .expect(201);
      const id = (res.body as NotificationChannelDto).id;
      await request(app.getHttpServer())
        .delete(`/api/notification-channels/${id}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(await prisma.notificationChannel.count({ where: { id } })).toBe(0);
      await request(app.getHttpServer())
        .delete(`/api/notification-channels/${id}`)
        .set('Cookie', cookie)
        .expect(404);
      await request(app.getHttpServer())
        .patch(`/api/notification-channels/${id}`)
        .set('Cookie', cookie)
        .send({ name: 'ghost' })
        .expect(404);
      await request(app.getHttpServer())
        .post(`/api/notification-channels/${id}/test`)
        .set('Cookie', cookie)
        .expect(404);
    });
  });

  // -------------------------------------------------------------- test-send --
  describe('POST /api/notification-channels/:id/test (real HTTP to a local receiver)', () => {
    it('webhook: delivers the EXACT v1-parity system.test payload — bypassing enabled/events filters', async () => {
      const create = await request(app.getHttpServer())
        .post('/api/notification-channels')
        .set('Cookie', cookie)
        .send({
          type: 'WEBHOOK',
          name: 'local hook',
          config: { url: `${receiverBase}/hook` },
          events: [], // wants nothing…
          enabled: false, // …and is disabled — test-send must STILL deliver (v1 send_test)
        })
        .expect(201);
      const id = (create.body as NotificationChannelDto).id;

      received.length = 0;
      receiverStatus = 200;
      const before = Date.now();
      const res = await request(app.getHttpServer())
        .post(`/api/notification-channels/${id}/test`)
        .set('Cookie', cookie)
        .expect(200);
      expect(res.body as TestNotificationChannelResponse).toEqual({
        delivered: true,
        detail: 'HTTP 200',
      });

      expect(received).toHaveLength(1);
      expect(received[0]!.url).toBe('/hook');
      expect(received[0]!.headers['content-type']).toBe('application/json');
      expect(received[0]!.headers['user-agent']).toBe('TubeVault (self-hosted archiver)');
      const payload = JSON.parse(received[0]!.body) as Record<string, unknown>;
      // EXACT deep-equal (not toMatchObject): an extra/leaked field must fail.
      // system.test carries no optionals (no dedupeKey/videoId/channelId/data).
      expect(payload).toEqual({
        type: 'system.test',
        severity: 'info', // v1 lowercase wire severity
        at: expect.any(String) as unknown,
        title: 'TubeVault test notification',
        body: 'If you can see this, this channel is configured correctly.', // v1 verbatim
      });
      expect(Date.parse(payload['at'] as string)).toBeGreaterThanOrEqual(before - 1000);

      // The in-app Notification row exists too (v1: send_test records the feed row).
      expect(await prisma.notification.count({ where: { type: 'system.test' } })).toBe(1);
    });

    it('gotify: POSTs {serverUrl}/message with the X-Gotify-Key header and priority 2 (INFO)', async () => {
      const create = await request(app.getHttpServer())
        .post('/api/notification-channels')
        .set('Cookie', cookie)
        .send({
          type: 'GOTIFY',
          name: 'local gotify',
          config: { serverUrl: receiverBase, appToken: APP_TOKEN },
        })
        .expect(201);
      const id = (create.body as NotificationChannelDto).id;

      received.length = 0;
      receiverStatus = 200;
      await request(app.getHttpServer())
        .post(`/api/notification-channels/${id}/test`)
        .set('Cookie', cookie)
        .expect(200);
      expect(received).toHaveLength(1);
      expect(received[0]!.url).toBe('/message');
      expect(received[0]!.headers['x-gotify-key']).toBe(APP_TOKEN);
      expect(JSON.parse(received[0]!.body)).toEqual({
        title: 'TubeVault test notification',
        message: 'If you can see this, this channel is configured correctly.',
        priority: 2,
      });
    });

    it('a failing receiver → 200 {delivered:false} with a secret-free detail', async () => {
      const create = await request(app.getHttpServer())
        .post('/api/notification-channels')
        .set('Cookie', cookie)
        .send({
          type: 'GOTIFY',
          name: 'failing gotify',
          config: { serverUrl: receiverBase, appToken: APP_TOKEN },
        })
        .expect(201);
      const id = (create.body as NotificationChannelDto).id;

      received.length = 0;
      receiverStatus = 500;
      const res = await request(app.getHttpServer())
        .post(`/api/notification-channels/${id}/test`)
        .set('Cookie', cookie)
        .expect(200);
      receiverStatus = 200;
      const body = res.body as TestNotificationChannelResponse;
      expect(body.delivered).toBe(false);
      expect(body.detail).toContain('HTTP 500');
      expect(body.detail).not.toContain(APP_TOKEN);
    });
  });

  // -------------------------------------------------- in-app notification center --
  describe('GET /api/notifications + dismiss', () => {
    const seeded: string[] = [];

    beforeAll(async () => {
      await prisma.notification.deleteMany({});
      for (let i = 0; i < 5; i += 1) {
        const row = await prisma.notification.create({
          data: {
            type: 'download.failed',
            severity: 'WARNING',
            title: `failure ${i}`,
            body: `body ${i}`,
            videoId: `vid${i}`,
            createdAt: new Date(Date.UTC(2026, 5, 1 + i)), // strictly increasing
          },
        });
        seeded.push(row.id);
      }
    });

    it('lists newest first with the DTO shape', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/notifications')
        .set('Cookie', cookie)
        .expect(200);
      const body = res.body as NotificationListResponse;
      expect(body.notifications.map((n) => n.title)).toEqual([
        'failure 4',
        'failure 3',
        'failure 2',
        'failure 1',
        'failure 0',
      ]);
      expect(body.nextCursor).toBeNull();
      expect(body.notifications[0]).toMatchObject({
        type: 'download.failed',
        severity: 'WARNING',
        body: 'body 4',
        videoId: 'vid4',
        dismissedAt: null,
      });
    });

    it('pages via limit + cursor (keyset, no overlap, terminates)', async () => {
      const page1 = await request(app.getHttpServer())
        .get('/api/notifications?limit=2')
        .set('Cookie', cookie)
        .expect(200);
      const b1 = page1.body as NotificationListResponse;
      expect(b1.notifications).toHaveLength(2);
      expect(b1.nextCursor).toBeTruthy();

      const page2 = await request(app.getHttpServer())
        .get(`/api/notifications?limit=2&cursor=${b1.nextCursor}`)
        .set('Cookie', cookie)
        .expect(200);
      const b2 = page2.body as NotificationListResponse;
      expect(b2.notifications.map((n) => n.title)).toEqual(['failure 2', 'failure 1']);

      const page3 = await request(app.getHttpServer())
        .get(`/api/notifications?limit=2&cursor=${b2.nextCursor}`)
        .set('Cookie', cookie)
        .expect(200);
      const b3 = page3.body as NotificationListResponse;
      expect(b3.notifications.map((n) => n.title)).toEqual(['failure 0']);
      expect(b3.nextCursor).toBeNull();
    });

    it('limit is validated: 0 / >500 / junk → 400', async () => {
      for (const bad of ['0', '501', 'many']) {
        await request(app.getHttpServer())
          .get(`/api/notifications?limit=${bad}`)
          .set('Cookie', cookie)
          .expect(400);
      }
    });

    it('an unknown/garbage cursor → 400 (validated existence, never Prisma cursor semantics)', async () => {
      await request(app.getHttpServer())
        .get('/api/notifications?cursor=nope-no-such-row')
        .set('Cookie', cookie)
        .expect(400);
    });

    it('dismiss stamps dismissedAt (idempotent); undismissed=true filters it out; unknown id → 404', async () => {
      const target = seeded[4]!; // 'failure 4'
      const res = await request(app.getHttpServer())
        .post(`/api/notifications/${target}/dismiss`)
        .set('Cookie', cookie)
        .expect(200);
      const dismissedAt = (res.body as { notification: { dismissedAt: string | null } })
        .notification.dismissedAt;
      expect(dismissedAt).toBeTruthy();

      // Idempotent: the SAME timestamp comes back (first dismissal wins).
      const again = await request(app.getHttpServer())
        .post(`/api/notifications/${target}/dismiss`)
        .set('Cookie', cookie)
        .expect(200);
      expect(
        (again.body as { notification: { dismissedAt: string | null } }).notification.dismissedAt,
      ).toBe(dismissedAt);

      const undismissed = await request(app.getHttpServer())
        .get('/api/notifications?undismissed=true')
        .set('Cookie', cookie)
        .expect(200);
      const titles = (undismissed.body as NotificationListResponse).notifications.map(
        (n) => n.title,
      );
      expect(titles).not.toContain('failure 4');
      expect(titles).toContain('failure 3');

      await request(app.getHttpServer())
        .post('/api/notifications/nope/dismiss')
        .set('Cookie', cookie)
        .expect(404);
    });
  });

  // ------------------------------- mark-all-read / bulk dismiss (CR-28) --
  describe('POST /api/notifications/dismiss-all + /dismiss (CR-28)', () => {
    /** Seed `count` fresh UNDISMISSED rows (strictly increasing createdAt). */
    async function seed(count: number): Promise<string[]> {
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const row = await prisma.notification.create({
          data: {
            type: 'download.failed',
            severity: 'WARNING',
            title: `bulk ${i}`,
            body: `body ${i}`,
            createdAt: new Date(Date.UTC(2026, 6, 1 + i)),
          },
        });
        ids.push(row.id);
      }
      return ids;
    }

    beforeEach(async () => {
      await prisma.notification.deleteMany({});
    });

    describe('dismiss-all (EP-41)', () => {
      it('dismisses every undismissed row, returns the newly-dismissed count, 200', async () => {
        await seed(3);
        const res = await request(app.getHttpServer())
          .post('/api/notifications/dismiss-all')
          .set('Cookie', cookie)
          .expect(200);
        expect(res.body as DismissAllNotificationsResponse).toEqual({ dismissed: 3 });

        // Every row now carries dismissedAt; the undismissed listing is empty.
        expect(await prisma.notification.count({ where: { dismissedAt: null } })).toBe(0);
        const undismissed = await request(app.getHttpServer())
          .get('/api/notifications?undismissed=true')
          .set('Cookie', cookie)
          .expect(200);
        expect((undismissed.body as NotificationListResponse).notifications).toHaveLength(0);
      });

      it('is idempotent: only newly-dismissed rows count; already-dismissed timestamps are preserved', async () => {
        const ids = await seed(2);
        // Pre-dismiss one row via EP-28 so dismiss-all must skip it.
        await request(app.getHttpServer())
          .post(`/api/notifications/${ids[0]}/dismiss`)
          .set('Cookie', cookie)
          .expect(200);
        const firstDismissedAt = (
          await prisma.notification.findUniqueOrThrow({ where: { id: ids[0]! } })
        ).dismissedAt;

        const res = await request(app.getHttpServer())
          .post('/api/notifications/dismiss-all')
          .set('Cookie', cookie)
          .expect(200);
        // Only the ONE still-undismissed row is newly dismissed.
        expect(res.body as DismissAllNotificationsResponse).toEqual({ dismissed: 1 });
        // The already-dismissed row keeps its original timestamp (first dismissal wins).
        expect(
          (
            await prisma.notification.findUniqueOrThrow({ where: { id: ids[0]! } })
          ).dismissedAt?.getTime(),
        ).toBe(firstDismissedAt?.getTime());

        // A second call has nothing left to do.
        const again = await request(app.getHttpServer())
          .post('/api/notifications/dismiss-all')
          .set('Cookie', cookie)
          .expect(200);
        expect(again.body as DismissAllNotificationsResponse).toEqual({ dismissed: 0 });
      });

      it('an empty feed → { dismissed: 0 }', async () => {
        const res = await request(app.getHttpServer())
          .post('/api/notifications/dismiss-all')
          .set('Cookie', cookie)
          .expect(200);
        expect(res.body as DismissAllNotificationsResponse).toEqual({ dismissed: 0 });
      });
    });

    describe('bulk dismiss by id (EP-42)', () => {
      it('mixed batch: newly-dismisses the undismissed ids, reports missing ids in failed, 200', async () => {
        const [a, b] = await seed(2);
        // Pre-dismiss b via EP-28 so it is an idempotent no-op here.
        await request(app.getHttpServer())
          .post(`/api/notifications/${b}/dismiss`)
          .set('Cookie', cookie)
          .expect(200);
        const bDismissedAt = (await prisma.notification.findUniqueOrThrow({ where: { id: b! } }))
          .dismissedAt;

        const res = await request(app.getHttpServer())
          .post('/api/notifications/dismiss')
          .set('Cookie', cookie)
          .send({ ids: [a, b, 'no-such-notification-id'] })
          .expect(200);
        // a = newly dismissed (1); b = existing-but-already-dismissed no-op (not
        // counted, not failed); the unknown id = failed not_found.
        expect(res.body as BulkDismissNotificationsResponse).toEqual({
          dismissed: 1,
          failed: [{ id: 'no-such-notification-id', reason: 'not_found' }],
        });
        expect(
          (await prisma.notification.findUniqueOrThrow({ where: { id: a! } })).dismissedAt,
        ).toBeTruthy();
        // b keeps its ORIGINAL dismiss timestamp (never re-stamped).
        expect(
          (
            await prisma.notification.findUniqueOrThrow({ where: { id: b! } })
          ).dismissedAt?.getTime(),
        ).toBe(bDismissedAt?.getTime());
      });

      it('is idempotent: a second dismiss of the same ids → { dismissed: 0, failed: [] }', async () => {
        const [a] = await seed(1);
        await request(app.getHttpServer())
          .post('/api/notifications/dismiss')
          .set('Cookie', cookie)
          .send({ ids: [a] })
          .expect(200);
        const again = await request(app.getHttpServer())
          .post('/api/notifications/dismiss')
          .set('Cookie', cookie)
          .send({ ids: [a] })
          .expect(200);
        expect(again.body as BulkDismissNotificationsResponse).toEqual({
          dismissed: 0,
          failed: [],
        });
      });

      it('duplicate ids collapse: [a, a] dismisses one row, an unknown appears once in failed', async () => {
        const [a] = await seed(1);
        const res = await request(app.getHttpServer())
          .post('/api/notifications/dismiss')
          .set('Cookie', cookie)
          .send({ ids: [a, a, 'ghost', 'ghost'] })
          .expect(200);
        expect(res.body as BulkDismissNotificationsResponse).toEqual({
          dismissed: 1,
          failed: [{ id: 'ghost', reason: 'not_found' }],
        });
      });

      it('invalid body → 400 (empty ids / >500 ids / missing ids / unknown key / id too long)', async () => {
        const server = app.getHttpServer();
        for (const body of [
          { ids: [] },
          { ids: Array.from({ length: 501 }, (_, i) => `id${i}`) }, // over the .max(500) batch bound
          {},
          { ids: ['x'], extra: 1 },
          { ids: ['a'.repeat(65)] },
          { ids: 'not-an-array' },
        ]) {
          await request(server)
            .post('/api/notifications/dismiss')
            .set('Cookie', cookie)
            .send(body)
            .expect(400);
        }
      });
    });
  });
});
