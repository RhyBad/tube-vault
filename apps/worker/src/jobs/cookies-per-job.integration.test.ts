/**
 * P8 cookies-per-job over the REAL consumers (BullMQ + pg + redis
 * testcontainers + fake-ytdlp): the spawn-ledger argv assertions (media,
 * subtitle AND enumerate passes carry `--cookies <path>` iff a usable
 * credential exists), the v1-parity NO-FOLD pins (download/enumerate outcomes
 * never touch session health — public successes prove nothing and AUTH
 * failures are ambiguous; the 2-strike machinery is service-level-tested in
 * session.service.integration.test.ts, awaiting its rescan-probe caller), and
 * the redaction tests: a hostile engine echoing cookie material into stderr
 * (media OR subtitle pass) must leave NO trace in Job.error, JobEvents,
 * VideoStatusEvents or Notification bodies.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { CredentialCipher } from '@tubevault/core';
import { PrismaClient } from '@tubevault/db';
import type { EngineConfig } from '@tubevault/engine';
import {
  BULLMQ_QUEUE_DOWNLOAD,
  BULLMQ_QUEUE_ENUMERATE,
  downloadAddOptions,
  enumerateAddOptions,
} from '@tubevault/types';
import { Queue } from 'bullmq';
import pg from 'pg';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type WorkerConfig } from '../config';
import { ControlSubscriber } from '../control/control-subscriber';
import { RedisPublisher } from '../redis-publisher';
import { NotificationsService } from '../services/notifications.service';
import { SessionService } from '../services/session.service';
import { VideoStateService } from '../services/video-state.service';
import { DownloadConsumer } from './download.processor';
import { EnumerateConsumer } from './enumerate.processor';
import { JobRecorder } from './job-recorder';

const migrationsDir = fileURLToPath(
  new URL('../../../../packages/db/prisma/migrations', import.meta.url),
);
const FAKE_YTDLP = fileURLToPath(
  new URL('../../../../packages/engine/test/fixtures/fake-ytdlp.mjs', import.meta.url),
);

const CHANNEL = 'UCcookiechannel000000000';
// Runtime-assembled jar (pre-commit secret scan: never the literal header).
const NETSCAPE_HEADER = ['#', 'Netscape', 'HTTP', 'Cookie', 'File'].join(' ');
const COOKIE_SECRET = 'distinctive-jar-value-1337-cafebabe';
// A value with a JSON-escapable character (the `"`): the post-JSON.stringify
// backstop in JobRecorder.event CANNOT mask it (stringify escapes the quote,
// so the registered value no longer matches) — only redaction at the SOURCE
// seam can. The subtitle-leak test below pins exactly that.
const QUOTED_COOKIE_SECRET = 'qu"oted-jar-value-4242-deadbeef';
const COOKIE_JAR = [
  NETSCAPE_HEADER,
  '',
  `.youtube.com\tTRUE\t/\tTRUE\t1799999999\tSIDCC\t${COOKIE_SECRET}`,
  `.youtube.com\tTRUE\t/\tTRUE\t1799999999\t__Secure-1PSID\t${QUOTED_COOKIE_SECRET}`,
].join('\n');

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

async function until(cond: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`condition not met within ${ms}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('cookies-per-job (P8, real consumers over pg + redis + fake-ytdlp)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let prisma: PrismaClient;
  let workerConfig: WorkerConfig;
  let engineConfig: EngineConfig;
  let control: ControlSubscriber;
  let publisher: RedisPublisher;
  let session: SessionService;
  let downloadConsumer: DownloadConsumer;
  let enumerateConsumer: EnumerateConsumer;
  let downloadQueue: Queue;
  let enumerateQueue: Queue;
  let vaultRoot: string;
  let spawnLog: string;
  let cipher: CredentialCipher;
  let videoSeq = 0;

  beforeAll(async () => {
    [pgContainer, redisContainer] = await Promise.all([
      new PostgreSqlContainer('postgres:17-alpine').start(),
      new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    ]);
    await applyMigrations(pgContainer.getConnectionUri());
    const dataDir = mkdtempSync(path.join(tmpdir(), 'tv-cookiejob-'));
    vaultRoot = path.join(dataDir, 'media');
    spawnLog = path.join(dataDir, 'spawns.log');

    const key = randomBytes(32);
    cipher = new CredentialCipher(key);
    workerConfig = {
      role: 'archive',
      databaseUrl: pgContainer.getConnectionUri(),
      redisHost: redisContainer.getHost(),
      redisPort: redisContainer.getMappedPort(6379),
      dataDir,
      vaultRoot,
      credentialKey: key,
    };
    engineConfig = { ytdlpBin: FAKE_YTDLP, throttle: null };
    const connection = {
      host: workerConfig.redisHost,
      port: workerConfig.redisPort,
      maxRetriesPerRequest: null,
    };

    prisma = new PrismaClient({ datasourceUrl: workerConfig.databaseUrl });
    control = new ControlSubscriber(workerConfig);
    await control.start();
    publisher = new RedisPublisher(workerConfig);
    // Warm the lazy publisher (established flake discipline).
    await publisher.publish('test:warmup', { warm: true });

    const recorder = new JobRecorder(prisma);
    const notifications = new NotificationsService(prisma);
    session = new SessionService(workerConfig, prisma, notifications);
    downloadConsumer = new DownloadConsumer(
      workerConfig,
      engineConfig,
      prisma,
      recorder,
      control,
      publisher,
      new VideoStateService(prisma, publisher),
      notifications,
      session,
    );
    downloadConsumer.start();
    enumerateConsumer = new EnumerateConsumer(
      workerConfig,
      engineConfig,
      prisma,
      recorder,
      control,
      publisher,
      session,
    );
    enumerateConsumer.start();

    downloadQueue = new Queue(BULLMQ_QUEUE_DOWNLOAD, { connection });
    enumerateQueue = new Queue(BULLMQ_QUEUE_ENUMERATE, { connection });

    await prisma.channel.create({
      data: { id: CHANNEL, url: 'https://www.youtube.com/@cookies', title: 'Cookie channel' },
    });
    process.env['FAKE_YTDLP_SPAWN_LOG'] = spawnLog;
  }, 180_000);

  afterAll(async () => {
    await downloadConsumer?.onModuleDestroy();
    await enumerateConsumer?.onModuleDestroy();
    await downloadQueue?.close();
    await enumerateQueue?.close();
    await control?.onApplicationShutdown();
    await publisher?.onApplicationShutdown();
    await prisma?.$disconnect();
    await Promise.all([pgContainer?.stop(), redisContainer?.stop()]);
    rmSync(path.dirname(vaultRoot), { recursive: true, force: true });
    delete process.env['FAKE_YTDLP_SPAWN_LOG'];
    delete process.env['FAKE_YTDLP_SCENARIO'];
  });

  afterEach(() => {
    delete process.env['FAKE_YTDLP_SCENARIO'];
  });

  /** The api-shape import: encrypted blob + reset health (UNVERIFIED/0). */
  async function importCredential(): Promise<void> {
    const encryptedBlob = new Uint8Array(cipher.encrypt(Buffer.from(COOKIE_JAR, 'utf8')));
    await prisma.credential.upsert({
      where: { id: 'youtube' },
      update: {
        encryptedBlob,
        status: 'UNVERIFIED',
        failureStreak: 0,
        lastError: null,
        lastVerifiedAt: null,
      },
      create: { id: 'youtube', encryptedBlob },
    });
  }

  async function runDownload(videoId: string): Promise<string> {
    await prisma.video.create({
      data: { id: videoId, channelId: CHANNEL, title: `Video ${videoId}`, copyState: 'QUEUED' },
    });
    const row = await prisma.job.create({
      data: { type: 'DOWNLOAD', status: 'QUEUED', videoId, priority: 1_048_576, payload: {} },
    });
    await prisma.job.update({ where: { id: row.id }, data: { bullJobId: row.id } });
    await downloadQueue.add(
      'download',
      { jobId: row.id },
      {
        ...downloadAddOptions(row.id, 1_048_576),
        attempts: 1, // single execution keeps the suite fast + deterministic
      },
    );
    return row.id;
  }

  async function runEnumerate(url: string): Promise<string> {
    const row = await prisma.job.create({
      data: { type: 'ENUMERATE', status: 'QUEUED', channelId: CHANNEL, payload: { url } },
    });
    await prisma.job.update({ where: { id: row.id }, data: { bullJobId: row.id } });
    await enumerateQueue.add(
      'enumerate',
      { jobId: row.id },
      {
        ...enumerateAddOptions(row.id),
        attempts: 1,
      },
    );
    return row.id;
  }

  async function untilRowStatus(jobId: string, status: string): Promise<void> {
    await until(async () => {
      const row = await prisma.job.findUnique({ where: { id: jobId } });
      return row?.status === status;
    }, 60_000);
  }

  function spawnsFor(needle: string): string[][] {
    if (!existsSync(spawnLog)) return [];
    return readFileSync(spawnLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[])
      .filter((argv) => argv.some((a) => a.includes(needle)));
  }

  function nextVideoId(): string {
    videoSeq += 1;
    return `ckvid${String(videoSeq).padStart(6, '0')}`;
  }

  it('credential seeded → --cookies <path> on the MEDIA and SUBTITLE passes; NO fold: the credential stays UNVERIFIED (v1 parity)', async () => {
    await importCredential();
    const videoId = nextVideoId();
    const jobId = await runDownload(videoId);
    await untilRowStatus(jobId, 'COMPLETED');

    const spawns = spawnsFor(videoId);
    const media = spawns.filter((argv) => !argv.includes('--skip-download'));
    const subs = spawns.filter((argv) => argv.includes('--skip-download'));
    expect(media).toHaveLength(1);
    expect(subs).toHaveLength(1);
    for (const argv of [...media, ...subs]) {
      const i = argv.indexOf('--cookies');
      expect(i).toBeGreaterThanOrEqual(0);
      expect(argv[i + 1]).toBeTruthy();
      // Cleanup runs in the processor's finally AFTER the row lands COMPLETED
      // (the poll target) — so poll for it rather than asserting instantly.
      await until(() => !existsSync(argv[i + 1]!));
    }

    // v1 parity (domain/credential.py:65-78): a download success proves NOTHING
    // about the session — a PUBLIC video completes with dead cookies too, so
    // folding 'success' here would falsely re-VERIFY and reset the streak. The
    // sound verifier is the rescan probe of previously-HEALTHY videos
    // (post-cutover); until then the credential must stay untouched.
    const cred = await prisma.credential.findUniqueOrThrow({ where: { id: 'youtube' } });
    expect(cred.status).toBe('UNVERIFIED');
    expect(cred.lastVerifiedAt).toBeNull();
    expect(cred.failureStreak).toBe(0);
  }, 90_000);

  it('credential seeded → --cookies on the ENUMERATE pass too; NO fold: the credential stays UNVERIFIED (v1 parity)', async () => {
    await importCredential(); // reset to UNVERIFIED
    const url = 'https://www.youtube.com/@cookies/videos';
    const jobId = await runEnumerate(url);
    await untilRowStatus(jobId, 'COMPLETED');

    const listing = spawnsFor('--flat-playlist').at(-1)!;
    const i = listing.indexOf('--cookies');
    expect(i).toBeGreaterThanOrEqual(0);
    // Cleanup follows the COMPLETED row (processor finally) — poll, don't race.
    await until(() => !existsSync(listing[i + 1]!));

    // Same no-fold rationale as the download leg: an honored LISTING is not a
    // positive re-verification of gated access.
    const cred = await prisma.credential.findUniqueOrThrow({ where: { id: 'youtube' } });
    expect(cred.status).toBe('UNVERIFIED');
    expect(cred.lastVerifiedAt).toBeNull();
  }, 90_000);

  it('NO credential → cookie-less argv on download, subtitle and enumerate passes', async () => {
    await prisma.credential.deleteMany({});
    const videoId = nextVideoId();
    const dlJob = await runDownload(videoId);
    await untilRowStatus(dlJob, 'COMPLETED');
    const enJob = await runEnumerate('https://www.youtube.com/@cookies/streams');
    await untilRowStatus(enJob, 'COMPLETED');

    for (const argv of spawnsFor(videoId)) {
      expect(argv).not.toContain('--cookies');
    }
    expect(spawnsFor('--flat-playlist').at(-1)!).not.toContain('--cookies');
  }, 90_000);

  it('an AUTH-classified failure under an ACTIVE session leaves the credential UNTOUCHED (no strike, no alert — v1 parity)', async () => {
    await importCredential();
    process.env['FAKE_YTDLP_SCENARIO'] = 'members';

    const videoId = nextVideoId();
    const jobId = await runDownload(videoId);
    await untilRowStatus(jobId, 'FAILED');

    // Cookies WERE injected (the credential is USABLE) and the failure IS
    // AUTH-classified on the job…
    const media = spawnsFor(videoId).at(-1)!;
    expect(media).toContain('--cookies');
    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.errorKind).toBe('AUTH');

    // …but it does NOT fold into session health: a download/enumerate AUTH
    // failure is AMBIGUOUS (this account may simply never have had access to
    // this members-only video) — with BullMQ attempts:5 a single such video
    // would strike the session out in ~30s (false EXPIRED + CRITICAL alert).
    // v1's ONLY production fold site is the rescan probe of previously-HEALTHY
    // videos (rescan.py:170-182) — post-cutover scope in v2. The 2-strike
    // machinery itself stays, service-level-tested in
    // session.service.integration.test.ts, awaiting that caller.
    const cred = await prisma.credential.findUniqueOrThrow({ where: { id: 'youtube' } });
    expect(cred.status).toBe('UNVERIFIED');
    expect(cred.failureStreak).toBe(0);
    expect(cred.lastError).toBeNull();
    expect(await prisma.notification.count({ where: { type: 'session.expired' } })).toBe(0);
  }, 90_000);

  it('REDACTION at the SUBTITLE seam: a leaking subs-pass stderr leaves no cookie material in the WARN JobEvent (incl. JSON-escapable values)', async () => {
    await importCredential();
    process.env['FAKE_YTDLP_SCENARIO'] = 'subsfail';

    const videoId = nextVideoId();
    const jobId = await runDownload(videoId);
    await untilRowStatus(jobId, 'COMPLETED'); // media kept; the subs failure is WARN-only (F4)

    const events = await prisma.jobEvent.findMany({ where: { jobId } });
    const warn = events.find((e) => e.message.includes('subtitle pass failed'));
    expect(warn).toBeDefined();
    const eventsText = JSON.stringify(events);
    // The leak DID reach the worker (the fake echoed the jar) — masked…
    expect(eventsText).toContain('***REDACTED***');
    expect(eventsText).not.toContain(COOKIE_SECRET);
    // …and the escaping caveat is covered: a value JSON.stringify would alter
    // (embedded `"`) escapes the post-stringify backstop — only redaction at
    // the SOURCE (before the context is persisted) catches it.
    expect(eventsText).not.toContain('oted-jar-value-4242-deadbeef');
  }, 90_000);

  it('REDACTION: an engine echoing the cookie jar into stderr leaves NO trace in any persisted record', async () => {
    await importCredential();
    process.env['FAKE_YTDLP_SCENARIO'] = 'leakcookies';

    const videoId = nextVideoId();
    const jobId = await runDownload(videoId);
    await untilRowStatus(jobId, 'FAILED');

    // The leak DID reach the worker (the fake echoed the jar) — prove the
    // redaction seam saw something to mask…
    const events = await prisma.jobEvent.findMany({ where: { jobId } });
    const eventsText = JSON.stringify(events);
    expect(eventsText).toContain('***REDACTED***');
    // …and that the values survive NOWHERE (incl. the JSON-escapable one).
    expect(eventsText).not.toContain(COOKIE_SECRET);
    expect(eventsText).not.toContain('oted-jar-value-4242-deadbeef');

    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.error ?? '').not.toContain(COOKIE_SECRET);
    expect(JSON.stringify(row.payload ?? {})).not.toContain(COOKIE_SECRET);

    const trail = await prisma.videoStatusEvent.findMany({ where: { videoId } });
    expect(JSON.stringify(trail)).not.toContain(COOKIE_SECRET);

    const notifications = await prisma.notification.findMany({});
    expect(JSON.stringify(notifications)).not.toContain(COOKIE_SECRET);
  }, 90_000);
});
