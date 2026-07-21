/**
 * apps/api e2e: a REAL Nest app (full AppModule DI, global prefix, global guard)
 * over a Testcontainers Postgres, driven with supertest.
 *
 * Redis choice (documented): RedisPubSubService is overridden with an in-memory
 * stub (the same RxJS Subjects, no socket) — the api only ever CONSUMES parsed
 * frames from it, so a live broker adds nothing here. Real-Redis behavior is
 * covered by the worker's control-subscriber integration tests and the compose
 * smoke (P4), and end-to-end worker→api SSE lands in P6.
 */
import { readdirSync, readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hash } from '@node-rs/argon2';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { JobProgressPayload, LiveChangedPayload } from '@tubevault/types';
import pg from 'pg';
import { Subject } from 'rxjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app-setup';
import { EnumerateQueueService } from '../src/channels/enumerate-queue';
import { DownloadQueueService } from '../src/queue/download-queue';
import { RedisPubSubService } from '../src/redis-pubsub.service';

const SECRET = 'correct-horse-battery-staple';
const SESSION_KEY = 'k'.repeat(48);

const migrationsDir = fileURLToPath(
  new URL('../../../packages/db/prisma/migrations', import.meta.url),
);

/** Apply Prisma migration SQL directly via pg (same harness as packages/db/test). */
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

/** In-memory stand-in for RedisPubSubService: same streams, no broker. */
class PubSubStub {
  readonly progress$ = new Subject<JobProgressPayload>();
  readonly changed$ = new Subject<unknown>();
  readonly videoChanged$ = new Subject<unknown>();
  readonly reordered$ = new Subject<unknown>();
  readonly liveChanged$ = new Subject<LiveChangedPayload>();
}

/**
 * Stand-in for the BullMQ producer services (same posture as the PubSub
 * stub): this suite never enqueues, and the real services would open BullMQ
 * connections that retry ECONNREFUSED against localhost:6379 for the whole
 * run. (The api's RedisPublisher needs no stub — it is lazy and this suite
 * never publishes.)
 */
class BullQueueStub {
  readonly queue = { add: async (): Promise<void> => undefined };
  async onModuleDestroy(): Promise<void> {}
}

describe('api e2e (real Nest app over Testcontainers Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let pubsub: PubSubStub;
  let validCookie: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    await applyMigrations(container.getConnectionUri());

    process.env['DATABASE_URL'] = container.getConnectionUri();
    process.env['TUBEVAULT_ACCESS_SECRET_HASH'] = await hash(SECRET);
    process.env['TUBEVAULT_SESSION_KEY'] = SESSION_KEY;
    delete process.env['TUBEVAULT_INSECURE_COOKIES'];

    pubsub = new PubSubStub();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RedisPubSubService)
      .useValue(pubsub)
      .overrideProvider(EnumerateQueueService)
      .useValue(new BullQueueStub())
      .overrideProvider(DownloadQueueService)
      .useValue(new BullQueueStub())
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app); // the SHARED prod stack (main.ts runs the same call)
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  it('GET /api/health is open and returns {status: ok}', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('POST /api/auth/login with a wrong secret is a generic 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ secret: 'not-the-secret' })
      .expect(401);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('POST /api/auth/login with the right secret sets the HttpOnly session cookie', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ secret: SECRET })
      .expect(200);
    const setCookie = res.headers['set-cookie'] as unknown as string[];
    expect(setCookie).toHaveLength(1);
    const cookie = setCookie[0]!;
    expect(cookie).toMatch(/^tv_session=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Secure'); // default-on (v1 parity); compose dev opts out
    validCookie = cookie.split(';')[0]!;
  });

  it('a guarded route is 401 JSON without a cookie', async () => {
    const res = await request(app.getHttpServer()).get('/api/settings').expect(401);
    expect(res.headers['content-type']).toContain('application/json'); // never a redirect
  });

  it('a guarded route is 401 with a TAMPERED cookie', async () => {
    const [payload, sig] = validCookie.replace('tv_session=', '').split('.') as [string, string];
    const forged = payload.slice(0, -1) + (payload.endsWith('A') ? 'B' : 'A');
    await request(app.getHttpServer())
      .get('/api/settings')
      .set('Cookie', `tv_session=${forged}.${sig}`)
      .expect(401);
  });

  it('a guarded route is 200 with the valid cookie', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/settings')
      .set('Cookie', validCookie)
      .expect(200);
    // P6b: /settings is the real Settings API now (singleton, schema defaults).
    expect(res.body).toEqual({
      downloadConcurrency: 1,
      qualityCap: 'UNLIMITED',
      subtitleMode: 'BOTH',
    });
  });

  it('GET /api/events unauthenticated is 401 (SSE guard: JSON, no redirect)', async () => {
    const res = await request(app.getHttpServer()).get('/api/events').expect(401);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('authenticated /api/events streams text/event-stream and emits frames', async () => {
    const server = app.getHttpServer() as http.Server;
    if (!server.listening) await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;

    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      http
        .get(
          { host: '127.0.0.1', port, path: '/api/events', headers: { cookie: validCookie } },
          resolve,
        )
        .on('error', reject);
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    // Publish progress frames until the first chunk lands (headers may flush
    // before the body; the 15s heartbeat is too slow for a test).
    const pump = setInterval(() => {
      pubsub.progress$.next({
        jobId: 'j1',
        videoId: 'v1',
        pct: 50,
        downloadedBytes: 1,
        totalBytes: null,
        speedBps: null,
        etaSeconds: null,
        currentFile: null,
      });
    }, 25);
    try {
      // Nest flushes a bare newline on connect; accumulate until a real frame lands.
      const received = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no SSE frame within 5s')), 5000);
        let buffer = '';
        res.on('data', (buf: Buffer) => {
          buffer += buf.toString('utf8');
          if (buffer.includes('\n\n') && buffer.includes('data:')) {
            clearTimeout(timer);
            resolve(buffer);
          }
        });
      });
      expect(received).toContain('job.progress');
      expect(received).toContain('"jobId":"j1"');

      // live.changed rides the same stream (P10): pump a session frame and
      // accumulate until it lands.
      const livePump = setInterval(() => {
        pubsub.liveChanged$.next({
          videoId: 'lv1',
          channelId: 'UClive',
          state: 'CAPTURING',
          sessionId: 's1',
        });
      }, 25);
      try {
        const live = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no live.changed within 5s')), 5000);
          let buffer = '';
          res.on('data', (buf: Buffer) => {
            buffer += buf.toString('utf8');
            if (buffer.includes('live.changed')) {
              clearTimeout(timer);
              resolve(buffer);
            }
          });
        });
        expect(live).toContain('"videoId":"lv1"');
        expect(live).toContain('"state":"CAPTURING"');
      } finally {
        clearInterval(livePump);
      }
    } finally {
      clearInterval(pump);
      res.destroy(); // abort after the first frame
    }
  });

  it('POST /api/auth/logout clears the cookie', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Cookie', validCookie)
      .expect(200);
    const setCookie = res.headers['set-cookie'] as unknown as string[];
    expect(setCookie[0]).toMatch(/^tv_session=;/);
  });

  it('POST /api/auth/logout is PUBLIC: an expired/absent session can still self-clear (v1 parity)', async () => {
    // v1 keeps /logout open (app.py) — a browser holding a dead cookie must be
    // able to clear it without first authenticating, or it is stuck logged "in".
    const res = await request(app.getHttpServer()).post('/api/auth/logout').expect(200);
    const setCookie = res.headers['set-cookie'] as unknown as string[];
    expect(setCookie[0]).toMatch(/^tv_session=;/);
  });

  // LAST: drains the per-IP bucket for this app instance.
  it('login rate limit locks out after the configured attempts → 429, even for the right secret', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const res = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ secret: 'wrong-again' });
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
    // Locked out means even the CORRECT secret is refused while drained.
    await request(app.getHttpServer()).post('/api/auth/login').send({ secret: SECRET }).expect(429);
  });

  it('FAIL-CLOSED boot: the module refuses to compile without TUBEVAULT_ACCESS_SECRET_HASH', async () => {
    const saved = process.env['TUBEVAULT_ACCESS_SECRET_HASH'];
    delete process.env['TUBEVAULT_ACCESS_SECRET_HASH'];
    try {
      await expect(Test.createTestingModule({ imports: [AppModule] }).compile()).rejects.toThrow(
        /TUBEVAULT_ACCESS_SECRET_HASH/,
      );
    } finally {
      process.env['TUBEVAULT_ACCESS_SECRET_HASH'] = saved;
    }
  });
});
