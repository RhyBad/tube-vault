/**
 * P9 media + global-videos e2e: the REAL Nest app (AppModule, global guard,
 * global prefix, shared configureApp) over Testcontainers Postgres + Redis,
 * with a REAL tmp vault on disk (TUBEVAULT_DATA_DIR) so `GET /api/media/:id`
 * streams actual bytes.
 *
 * Covers: Range semantics (200 full / 206 start-end, start-, -suffix with
 * EXACT bytes + headers / 416 / first-of-many ranges), title-change-proof file
 * resolution (existingDir), thumbnail dir-scan, the cross-channel videos
 * listing + detail (status trail asc), the 401 gate on every new endpoint, and
 * the P9 trust-proxy seam (login rate limiting keyed by the FORWARDED client
 * IP, per the P4 auth.controller SEAM note).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hash } from '@node-rs/argon2';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@tubevault/db';
import type {
  SubtitleListResponse,
  VideoDetailResponse,
  VideoListResponse,
} from '@tubevault/types';
import pg from 'pg';
import request from 'supertest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app-setup';

const SECRET = 'correct-horse-battery-staple';
const SESSION_KEY = 'k'.repeat(48);
const CH1 = 'UCmediachannel0000000001';
const CH2 = 'UCmediachannel0000000002';
const VID = 'mediavid001'; // HEALTHY, real file on disk
const VID_RENAMED = 'mediavid002'; // dir on disk carries the OLD title
const VID_NO_MEDIA = 'mediavid003'; // CANDIDATE: no mediaExt
const VID_GONE = 'mediavid004'; // row says mp4, file was deleted
const VID_EMPTY = 'mediavid005'; // real file on disk, ZERO bytes
const VID_BADEXT = 'mediavid006'; // hostile mediaExt row: traversal to /etc/passwd
const VID_EVIL_ID = 'evil.id.row'; // safeId-rejected id (dots) — nothing on disk can match

// CR-14/CR-16 detail-only fields: VID carries a description + a TERMINAL
// download (must NOT surface as active); VID_NO_MEDIA owns an ACTIVE download.
const VID_DESCRIPTION = 'The archived video description.\nWith a second line ✓.';
const ACTIVE_DL_JOB = 'activedljob000001';

// A hostile DB row's ext aimed at a file that EXISTS outside the vault: with
// no containment guard the api would stat it fine and stream it (the audit's
// traversal shape).
const HOSTILE_EXT = `x/${'../'.repeat(12)}etc/passwd`;

// 2000 distinct bytes so range assertions can't pass by accident.
const MEDIA_BYTES = Buffer.alloc(2000);
for (let i = 0; i < MEDIA_BYTES.length; i += 1) MEDIA_BYTES[i] = i % 251;
const THUMB_BYTES = Buffer.from('RIFFfake-webp-payload');

// CR-17 subtitle sidecars for VID: a native WebVTT track (served verbatim) + an
// SRT track (converted on the fly) + an ass track (must be excluded — not
// <track>-viable).
const SUB_EN_VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello from VTT\n';
const SUB_ES_SRT = '1\n00:00:01,500 --> 00:00:03,500\nHola, mundo\n';
// de has BOTH formats on disk — the native .vtt must win (list dedupe + serve).
const SUB_DE_VTT = 'WEBVTT\n\n00:00:02.000 --> 00:00:04.000\nHallo (native vtt)\n';
const SUB_DE_SRT = '1\n00:00:09,000 --> 00:00:10,000\nUNUSED srt — vtt should win\n';

const migrationsDir = fileURLToPath(
  new URL('../../../packages/db/prisma/migrations', import.meta.url),
);

async function applyMigrations(connectionString: string): Promise<void> {
  const { readdirSync, readFileSync } = await import('node:fs');
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

describe('media + global videos e2e (P9, real Nest app over pg + redis testcontainers)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let app: INestApplication;
  let prisma: PrismaClient;
  let dataDir: string;
  let cookie: string;

  beforeAll(async () => {
    [pgContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:17-alpine').start(),
      new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    ]);
    await applyMigrations(pgContainer.getConnectionUri());

    dataDir = mkdtempSync(path.join(tmpdir(), 'tubevault-media-e2e-'));
    const vaultRoot = path.join(dataDir, 'media');

    process.env['DATABASE_URL'] = pgContainer.getConnectionUri();
    process.env['REDIS_HOST'] = redisContainer.getHost();
    process.env['REDIS_PORT'] = String(redisContainer.getMappedPort(6379));
    process.env['TUBEVAULT_ACCESS_SECRET_HASH'] = await hash(SECRET);
    process.env['TUBEVAULT_SESSION_KEY'] = SESSION_KEY;
    process.env['TUBEVAULT_DATA_DIR'] = dataDir;
    delete process.env['TUBEVAULT_INSECURE_COOKIES'];

    prisma = new PrismaClient({ datasourceUrl: pgContainer.getConnectionUri() });

    // ---- seed rows -------------------------------------------------------
    await prisma.channel.createMany({
      data: [
        { id: CH1, url: 'https://www.youtube.com/@media1', title: 'Media Channel One' },
        { id: CH2, url: 'https://www.youtube.com/@media2', title: 'Media Channel Two' },
      ],
    });
    await prisma.video.createMany({
      data: [
        {
          id: VID,
          channelId: CH1,
          title: 'Healthy archived video',
          copyState: 'HEALTHY',
          mediaExt: 'mp4',
          sizeBytes: BigInt(MEDIA_BYTES.length),
          checksumSha256: 'a'.repeat(64),
          publishedAt: new Date('2024-03-01T00:00:00Z'),
          description: VID_DESCRIPTION, // CR-14: exposed on detail only
        },
        {
          id: VID_RENAMED,
          channelId: CH1,
          title: 'NEW title after rename',
          copyState: 'HEALTHY',
          mediaExt: 'webm',
        },
        { id: VID_NO_MEDIA, channelId: CH2, title: 'Needle candidate video' },
        { id: VID_GONE, channelId: CH2, title: 'Vanished file video', mediaExt: 'mp4' },
        { id: VID_EMPTY, channelId: CH1, title: 'Zero byte capture', mediaExt: 'mp4' },
        { id: VID_BADEXT, channelId: CH1, title: 'Hostile ext row', mediaExt: HOSTILE_EXT },
        { id: VID_EVIL_ID, channelId: CH1, title: 'Hostile id row', mediaExt: 'mp4' },
      ],
    });
    await prisma.videoStatusEvent.createMany({
      data: [
        {
          videoId: VID,
          axis: 'COPY',
          oldState: 'CANDIDATE',
          newState: 'QUEUED',
          note: 'enqueue',
          at: new Date('2024-05-01T00:00:00Z'),
        },
        {
          videoId: VID,
          axis: 'COPY',
          oldState: 'DOWNLOADING',
          newState: 'VERIFYING',
          note: '',
          at: new Date('2024-05-01T02:00:00Z'),
        },
        {
          videoId: VID,
          axis: 'COPY',
          oldState: 'QUEUED',
          newState: 'DOWNLOADING',
          note: '',
          at: new Date('2024-05-01T01:00:00Z'),
        },
      ],
    });
    // CR-16 fixtures: an ACTIVE (RUNNING) DOWNLOAD owns VID_NO_MEDIA; a TERMINAL
    // (COMPLETED) DOWNLOAD hangs off VID — the detail join must surface the
    // former and IGNORE the latter (ux_job_active_download's status predicate).
    await prisma.job.createMany({
      data: [
        { id: ACTIVE_DL_JOB, type: 'DOWNLOAD', status: 'RUNNING', videoId: VID_NO_MEDIA },
        { type: 'DOWNLOAD', status: 'COMPLETED', videoId: VID },
      ],
    });

    // ---- seed files ------------------------------------------------------
    // VID: directory named from the CURRENT title (the pathsFor fallback path).
    const vidDir = path.join(vaultRoot, CH1, `${VID} - Healthy archived video`);
    mkdirSync(vidDir, { recursive: true });
    writeFileSync(path.join(vidDir, `${VID}.mp4`), MEDIA_BYTES);
    writeFileSync(path.join(vidDir, `${VID}.webp`), THUMB_BYTES);
    // A jpg NEXT TO the webp: the preference order (webp > jpg) must hold.
    writeFileSync(path.join(vidDir, `${VID}.jpg`), Buffer.from('jpg-decoy'));
    // CR-17 subtitle sidecars (same <videoId>.<lang>.<ext> layout as the media).
    writeFileSync(path.join(vidDir, `${VID}.en.vtt`), SUB_EN_VTT);
    writeFileSync(path.join(vidDir, `${VID}.es.srt`), SUB_ES_SRT);
    writeFileSync(path.join(vidDir, `${VID}.de.vtt`), SUB_DE_VTT);
    writeFileSync(path.join(vidDir, `${VID}.de.srt`), SUB_DE_SRT); // vtt beside it wins
    writeFileSync(path.join(vidDir, `${VID}.fr.ass`), '[Script Info]\nTitle: x\n'); // excluded
    // VID_EMPTY: a real, zero-byte media file.
    const emptyDir = path.join(vaultRoot, CH1, `${VID_EMPTY} - Zero byte capture`);
    mkdirSync(emptyDir, { recursive: true });
    writeFileSync(path.join(emptyDir, `${VID_EMPTY}.mp4`), Buffer.alloc(0));
    // VID_BADEXT: the directory exists; the row's ext points OUTSIDE the vault.
    mkdirSync(path.join(vaultRoot, CH1, `${VID_BADEXT} - Hostile ext row`), { recursive: true });
    // VID_RENAMED: directory named from the OLD title — resolution must go
    // through existingDir (identity = videoId), not the current-title leaf.
    const renamedDir = path.join(vaultRoot, CH1, `${VID_RENAMED} - Old title before rename`);
    mkdirSync(renamedDir, { recursive: true });
    writeFileSync(path.join(renamedDir, `${VID_RENAMED}.webm`), Buffer.from('webm-bytes'));
    // VID_GONE: directory exists but the media file does NOT.
    mkdirSync(path.join(vaultRoot, CH2, `${VID_GONE} - Vanished file video`), { recursive: true });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app); // the SHARED prod stack (main.ts runs the same call)
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
    await Promise.all([pgContainer?.stop(), redisContainer?.stop()]);
    rmSync(dataDir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------ guard --
  it('every new endpoint is 401 JSON without a session cookie', async () => {
    const server = app.getHttpServer();
    for (const url of [
      `/api/media/${VID}`,
      `/api/media/${VID}/thumbnail`,
      `/api/media/${VID}/subtitles`,
      `/api/media/${VID}/subtitles/en`,
      '/api/videos',
      `/api/videos/${VID}`,
    ]) {
      const res = await request(server).get(url).expect(401);
      expect(res.headers['content-type']).toContain('application/json');
    }
  });

  // ------------------------------------------------------------------ media --
  describe('GET /api/media/:videoId', () => {
    it('no Range header → 200 full body with Content-Length + Accept-Ranges + Content-Type', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/media/${VID}`)
        .set('Cookie', cookie)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(res.headers['content-type']).toBe('video/mp4');
      expect(res.headers['content-length']).toBe(String(MEDIA_BYTES.length));
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(Buffer.compare(res.body as Buffer, MEDIA_BYTES)).toBe(0);
    });

    async function rangeBytes(
      header: string,
    ): Promise<{ body: Buffer; headers: Record<string, string> }> {
      const res = await request(app.getHttpServer())
        .get(`/api/media/${VID}`)
        .set('Cookie', cookie)
        .set('Range', header)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(206);
      return { body: res.body as Buffer, headers: res.headers as Record<string, string> };
    }

    it('bytes=start-end → 206 with exact bytes and Content-Range', async () => {
      const { body, headers } = await rangeBytes('bytes=100-299');
      expect(headers['content-range']).toBe(`bytes 100-299/${MEDIA_BYTES.length}`);
      expect(headers['content-length']).toBe('200');
      expect(headers['content-type']).toBe('video/mp4');
      expect(Buffer.compare(body, MEDIA_BYTES.subarray(100, 300))).toBe(0);
    });

    it('bytes=start- → 206 through EOF', async () => {
      const { body, headers } = await rangeBytes('bytes=1900-');
      expect(headers['content-range']).toBe(`bytes 1900-1999/${MEDIA_BYTES.length}`);
      expect(headers['content-length']).toBe('100');
      expect(Buffer.compare(body, MEDIA_BYTES.subarray(1900))).toBe(0);
    });

    it('bytes=-suffix → 206 with the LAST bytes', async () => {
      const { body, headers } = await rangeBytes('bytes=-50');
      expect(headers['content-range']).toBe(`bytes 1950-1999/${MEDIA_BYTES.length}`);
      expect(Buffer.compare(body, MEDIA_BYTES.subarray(1950))).toBe(0);
    });

    it('multiple ranges: the FIRST is served, extras ignored (single-range only)', async () => {
      const { headers } = await rangeBytes('bytes=0-9,100-199');
      expect(headers['content-range']).toBe(`bytes 0-9/${MEDIA_BYTES.length}`);
      expect(headers['content-length']).toBe('10');
    });

    it('bytes=0-0 → 206 with exactly ONE byte', async () => {
      const { body, headers } = await rangeBytes('bytes=0-0');
      expect(headers['content-range']).toBe(`bytes 0-0/${MEDIA_BYTES.length}`);
      expect(headers['content-length']).toBe('1');
      expect(body.length).toBe(1);
      expect(body[0]).toBe(MEDIA_BYTES[0]);
    });

    it('an UNKNOWN range unit is ignored → 200 full (RFC 9110 §14.2), never 416', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/media/${VID}`)
        .set('Cookie', cookie)
        .set('Range', 'items=0-499')
        .expect(200);
      expect(res.headers['content-length']).toBe(String(MEDIA_BYTES.length));
      expect(res.headers['accept-ranges']).toBe('bytes');
    });

    it('HEAD answers the full header story with an EMPTY body (and no stream)', async () => {
      const server = app.getHttpServer();
      const full = await request(server)
        .head(`/api/media/${VID}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(full.headers['content-type']).toBe('video/mp4');
      expect(full.headers['content-length']).toBe(String(MEDIA_BYTES.length));
      expect(full.headers['accept-ranges']).toBe('bytes');
      expect(full.text ?? '').toBe('');

      const ranged = await request(server)
        .head(`/api/media/${VID}`)
        .set('Cookie', cookie)
        .set('Range', 'bytes=100-299')
        .expect(206);
      expect(ranged.headers['content-range']).toBe(`bytes 100-299/${MEDIA_BYTES.length}`);
      expect(ranged.headers['content-length']).toBe('200');
      expect(ranged.text ?? '').toBe('');
    });

    it('empty file: full read → 200 with length 0; ANY range → 416', async () => {
      const server = app.getHttpServer();
      const full = await request(server)
        .get(`/api/media/${VID_EMPTY}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(full.headers['content-length']).toBe('0');
      const ranged = await request(server)
        .get(`/api/media/${VID_EMPTY}`)
        .set('Cookie', cookie)
        .set('Range', 'bytes=0-')
        .expect(416);
      expect(ranged.headers['content-range']).toBe('bytes */0');
    });

    it('a hostile mediaExt row 404s — the traversal target is NEVER streamed', async () => {
      await request(app.getHttpServer())
        .get(`/api/media/${VID_BADEXT}`)
        .set('Cookie', cookie)
        .expect(404);
    });

    it('a safeId-rejected videoId row 404s (nothing on disk can match it)', async () => {
      await request(app.getHttpServer())
        .get(`/api/media/${VID_EVIL_ID}`)
        .set('Cookie', cookie)
        .expect(404);
    });

    it('unsatisfiable / malformed ranges → 416 with Content-Range bytes */size', async () => {
      for (const bad of ['bytes=2000-', 'bytes=500-100', 'bytes=abc']) {
        const res = await request(app.getHttpServer())
          .get(`/api/media/${VID}`)
          .set('Cookie', cookie)
          .set('Range', bad)
          .expect(416);
        expect(res.headers['content-range']).toBe(`bytes */${MEDIA_BYTES.length}`);
      }
    });

    it('resolves the file via existingDir when the TITLE changed (identity = videoId)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/media/${VID_RENAMED}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(res.headers['content-type']).toBe('video/webm');
      expect(res.headers['content-length']).toBe('10'); // 'webm-bytes'
    });

    it('404s: unknown video, no mediaExt, file missing on disk', async () => {
      await request(app.getHttpServer())
        .get('/api/media/nosuchvid00')
        .set('Cookie', cookie)
        .expect(404);
      await request(app.getHttpServer())
        .get(`/api/media/${VID_NO_MEDIA}`)
        .set('Cookie', cookie)
        .expect(404);
      await request(app.getHttpServer())
        .get(`/api/media/${VID_GONE}`)
        .set('Cookie', cookie)
        .expect(404);
    });
  });

  // -------------------------------------------------------------- thumbnail --
  describe('GET /api/media/:videoId/thumbnail', () => {
    it('serves the dir-scanned <id>.webp with its image Content-Type (webp PREFERRED over the jpg beside it) and an hour of private caching', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/media/${VID}/thumbnail`)
        .set('Cookie', cookie)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers['cache-control']).toBe('private, max-age=3600');
      expect(Buffer.compare(res.body as Buffer, THUMB_BYTES)).toBe(0);
    });

    it('404 when no thumbnail exists (and for unknown videos)', async () => {
      await request(app.getHttpServer())
        .get(`/api/media/${VID_RENAMED}/thumbnail`)
        .set('Cookie', cookie)
        .expect(404);
      await request(app.getHttpServer())
        .get('/api/media/nosuchvid00/thumbnail')
        .set('Cookie', cookie)
        .expect(404);
    });
  });

  // -------------------------------------------------------------- subtitles --
  describe('GET /api/media/:videoId/subtitles (CR-17)', () => {
    it('lists the dir-scanned tracks (vtt + srt, ass EXCLUDED), sorted, with labels', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/media/${VID}/subtitles`)
        .set('Cookie', cookie)
        .expect(200);
      const body = res.body as SubtitleListResponse;
      expect(body.subtitles).toEqual([
        { lang: 'de', label: 'German', format: 'vtt' }, // .vtt wins over the .srt beside it
        { lang: 'en', label: 'English', format: 'vtt' },
        { lang: 'es', label: 'Spanish', format: 'srt' },
      ]);
    });

    it('a KNOWN video with no subtitle sidecars → 200 {subtitles: []} (not 404)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/media/${VID_NO_MEDIA}/subtitles`)
        .set('Cookie', cookie)
        .expect(200);
      expect((res.body as SubtitleListResponse).subtitles).toEqual([]);
    });

    it('an UNKNOWN video → 404 (only the video, never the empty list, 404s)', async () => {
      await request(app.getHttpServer())
        .get('/api/media/nosuchvid00/subtitles')
        .set('Cookie', cookie)
        .expect(404);
    });
  });

  describe('GET /api/media/:videoId/subtitles/:lang (CR-17)', () => {
    it('serves a native .vtt track verbatim as text/vtt with private caching', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/media/${VID}/subtitles/en`)
        .set('Cookie', cookie)
        .expect(200);
      expect(res.headers['content-type']).toBe('text/vtt; charset=utf-8');
      expect(res.headers['cache-control']).toBe('private, max-age=3600');
      expect(res.text).toBe(SUB_EN_VTT);
    });

    it('a lang with BOTH .vtt and .srt serves the native .vtt verbatim (vtt preferred)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/media/${VID}/subtitles/de`)
        .set('Cookie', cookie)
        .expect(200);
      expect(res.text).toBe(SUB_DE_VTT); // the native vtt, NOT the converted srt
      expect(res.text).not.toContain('UNUSED');
    });

    it('converts a stored .srt to WebVTT on the fly (header + dotted timecodes)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/media/${VID}/subtitles/es`)
        .set('Cookie', cookie)
        .expect(200);
      expect(res.headers['content-type']).toBe('text/vtt; charset=utf-8');
      expect(res.text.startsWith('WEBVTT\n\n')).toBe(true);
      expect(res.text).toContain('00:00:01.500 --> 00:00:03.500'); // comma → dot
      expect(res.text).toContain('Hola, mundo');
    });

    it('404s: unknown video, unknown lang, an ass-only lang (not serveable), malformed lang/id', async () => {
      const server = app.getHttpServer();
      await request(server)
        .get('/api/media/nosuchvid00/subtitles/en')
        .set('Cookie', cookie)
        .expect(404);
      await request(server).get(`/api/media/${VID}/subtitles/ja`).set('Cookie', cookie).expect(404);
      // fr exists ONLY as .ass (not <track>-viable) → no vtt/srt to serve → 404.
      await request(server).get(`/api/media/${VID}/subtitles/fr`).set('Cookie', cookie).expect(404);
      // A lang with a dot fails safeId (would-be traversal shape) → 404, never a 500.
      await request(server)
        .get(`/api/media/${VID}/subtitles/en.US`)
        .set('Cookie', cookie)
        .expect(404);
      // safeId-rejected videoId row → 404 (nothing on disk can match it).
      await request(server)
        .get(`/api/media/${VID_EVIL_ID}/subtitles/en`)
        .set('Cookie', cookie)
        .expect(404);
    });
  });

  // ----------------------------------------------------------- videos (all) --
  describe('GET /api/videos (cross-channel)', () => {
    async function list(query: string): Promise<VideoListResponse> {
      const res = await request(app.getHttpServer())
        .get(`/api/videos${query}`)
        .set('Cookie', cookie)
        .expect(200);
      return res.body as VideoListResponse;
    }

    it('lists across channels; every item carries channelTitle', async () => {
      const body = await list('?sort=addedAt_desc&limit=100');
      expect(body.total).toBe(7);
      const byId = new Map(body.videos.map((v) => [v.id, v]));
      expect(byId.get(VID)?.channelTitle).toBe('Media Channel One');
      expect(byId.get(VID_NO_MEDIA)?.channelTitle).toBe('Media Channel Two');
    });

    it('search is a cross-channel case-insensitive title contains', async () => {
      const body = await list('?search=needle');
      expect(body.total).toBe(1);
      expect(body.videos[0]?.id).toBe(VID_NO_MEDIA);
    });

    it('copyState + channelId narrow the set (and total)', async () => {
      const healthy = await list('?copyState=HEALTHY');
      expect(healthy.total).toBe(2);
      const ch2 = await list(`?channelId=${CH2}`);
      expect(ch2.total).toBe(2);
      expect(ch2.videos.every((v) => v.channelId === CH2)).toBe(true);
    });

    it('bad copyState / over-limit / oversized channelId → 400', async () => {
      await request(app.getHttpServer())
        .get('/api/videos?copyState=NOT_A_STATE')
        .set('Cookie', cookie)
        .expect(400);
      await request(app.getHttpServer())
        .get('/api/videos?limit=9999')
        .set('Cookie', cookie)
        .expect(400);
      await request(app.getHttpServer())
        .get(`/api/videos?channelId=${'U'.repeat(300)}`)
        .set('Cookie', cookie)
        .expect(400);
    });
  });

  // ---------------------------------------------------------- video detail --
  describe('GET /api/videos/:id', () => {
    it('returns the video + channelTitle + the status trail ASC', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/videos/${VID}`)
        .set('Cookie', cookie)
        .expect(200);
      const body = res.body as VideoDetailResponse;
      expect(body.video.id).toBe(VID);
      expect(body.video.sizeBytes).toBe(MEDIA_BYTES.length); // BigInt → number
      expect(body.video.checksumSha256).toBe('a'.repeat(64)); // Video page shows it
      expect(body.channelTitle).toBe('Media Channel One');
      // CR-14: description is exposed on detail (and ONLY detail — never VideoDto).
      expect(body.description).toBe(VID_DESCRIPTION);
      // CR-16: VID's only DOWNLOAD is COMPLETED (terminal) → NOT active.
      expect(body.activeDownloadJobId).toBeNull();
      expect(body.activeDownloadStatus).toBeNull();
      // Seeded out of order; the api must return them ascending by time.
      expect(body.events.map((e) => `${e.from}->${e.to}`)).toEqual([
        'CANDIDATE->QUEUED',
        'QUEUED->DOWNLOADING',
        'DOWNLOADING->VERIFYING',
      ]);
      expect(body.events[0]).toMatchObject({ axis: 'COPY', note: 'enqueue' });
    });

    it('surfaces the active DOWNLOAD job (id + status); description is null when uncaptured (CR-14/CR-16)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/videos/${VID_NO_MEDIA}`)
        .set('Cookie', cookie)
        .expect(200);
      const body = res.body as VideoDetailResponse;
      expect(body.activeDownloadJobId).toBe(ACTIVE_DL_JOB);
      expect(body.activeDownloadStatus).toBe('RUNNING');
      // A flat-enumerated candidate never had a full-metadata fetch → null.
      expect(body.description).toBeNull();
    });

    it('detail-only fields never leak into the list projection (VideoDto stays lean)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/videos?limit=100')
        .set('Cookie', cookie)
        .expect(200);
      const item = (res.body as VideoListResponse).videos.find((v) => v.id === VID);
      expect(item).toBeDefined();
      expect(item).not.toHaveProperty('description');
      expect(item).not.toHaveProperty('activeDownloadJobId');
      expect(item).not.toHaveProperty('activeDownloadStatus');
    });

    it('unknown video → 404', async () => {
      await request(app.getHttpServer())
        .get('/api/videos/nosuchvid00')
        .set('Cookie', cookie)
        .expect(404);
    });
  });

  // ------------------------------------------------------------ trust proxy --
  describe('trust proxy (P9 seam: nginx forwards the real client IP)', () => {
    it('login rate limiting keys on the FORWARDED IP: draining one client does not lock out another', async () => {
      const server = app.getHttpServer();
      // Drain 203.0.113.7's bucket (capacity 5).
      for (let i = 0; i < 5; i += 1) {
        await request(server)
          .post('/api/auth/login')
          .set('X-Forwarded-For', '203.0.113.7')
          .send({ secret: 'wrong' })
          .expect(401);
      }
      await request(server)
        .post('/api/auth/login')
        .set('X-Forwarded-For', '203.0.113.7')
        .send({ secret: 'wrong' })
        .expect(429);
      // A DIFFERENT forwarded client still gets a fresh bucket (401, not 429):
      // without trust proxy every client shares the proxy's IP → one bucket.
      await request(server)
        .post('/api/auth/login')
        .set('X-Forwarded-For', '203.0.113.8')
        .send({ secret: 'wrong' })
        .expect(401);
    });

    it('a spoofed multi-hop XFF keys on the LAST untrusted hop — leftmost values mint NO fresh buckets', async () => {
      // The nginx contract (apps/web/nginx.conf, pinned by its own test) is
      // X-Forwarded-For OVERWRITTEN with $remote_addr — exactly one value.
      // Express `trust proxy` walks from the socket (loopback, trusted) to the
      // RIGHTMOST untrusted entry; everything left of it is attacker prose.
      // Here every request varies the leftmost value under a fixed last hop:
      // they must all drain ONE bucket (429 on the 6th), or a flood could mint
      // a fresh bucket per forged leftmost IP and evade the limiter.
      const server = app.getHttpServer();
      for (let i = 0; i < 5; i += 1) {
        await request(server)
          .post('/api/auth/login')
          .set('X-Forwarded-For', `198.51.100.${i}, 203.0.113.50`)
          .send({ secret: 'wrong' })
          .expect(401);
      }
      await request(server)
        .post('/api/auth/login')
        .set('X-Forwarded-For', '198.51.100.99, 203.0.113.50')
        .send({ secret: 'wrong' })
        .expect(429);
    });
  });
});
