import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { JobStatus, JobType, PrismaClient } from '@tubevault/db';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JobRecorder } from './job-recorder';

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

describe('JobRecorder (integration: CAS transitions on the Job table)', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let recorder: JobRecorder;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    await applyMigrations(container.getConnectionUri());
    prisma = new PrismaClient({ datasourceUrl: container.getConnectionUri() });
    recorder = new JobRecorder(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  async function createJob(status: JobStatus): Promise<string> {
    const job = await prisma.job.create({ data: { type: JobType.ENUMERATE, status } });
    return job.id;
  }

  it('markRunning flips a QUEUED row to RUNNING (true) and records startedAt + bullJobId', async () => {
    const jobId = await createJob(JobStatus.QUEUED);
    await expect(recorder.markRunning(jobId, 'bull-1')).resolves.toBe(true);
    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe(JobStatus.RUNNING);
    expect(row.startedAt).toBeInstanceOf(Date);
    expect(row.bullJobId).toBe('bull-1');
  });

  it('markRunning CAS returns FALSE when the row is not QUEUED (canceled in the pickup window)', async () => {
    const canceled = await createJob(JobStatus.CANCELED);
    await expect(recorder.markRunning(canceled, 'bull-2')).resolves.toBe(false);
    const row = await prisma.job.findUniqueOrThrow({ where: { id: canceled } });
    expect(row.status).toBe(JobStatus.CANCELED); // untouched — the work must be skipped

    const running = await createJob(JobStatus.RUNNING);
    await expect(recorder.markRunning(running, 'bull-3')).resolves.toBe(false);
  });

  describe('claimForAttempt (BullMQ pickup CAS, re-execution-aware — P5 enumerate/P6 download seam)', () => {
    // The re-execution signal is bullmq's attemptsStarted (incremented on EVERY
    // activation, including stalled-job requeues), NOT attemptsMade (which only
    // counts failure-retries and stays 0 across a stall).
    it('first activation (attemptsStarted 1): QUEUED → RUNNING with bullJobId + startedAt + attempt 1 (first execution of the row)', async () => {
      const jobId = await createJob(JobStatus.QUEUED);
      await expect(recorder.claimForAttempt(jobId, 'exec-1', 1)).resolves.toBe(true);
      const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
      expect(row.status).toBe(JobStatus.RUNNING);
      expect(row.bullJobId).toBe('exec-1');
      expect(row.startedAt).toBeInstanceOf(Date);
      // attempt = TOTAL executions of the ROW (P7): each claim increments — it
      // is NEVER derived from bullmq's attemptsStarted, which restarts at 1 on
      // the fresh bull job a resume creates.
      expect(row.attempt).toBe(1);
    });

    it('first activation (attemptsStarted 1) refuses a RUNNING row (double-run guard, like markRunning)', async () => {
      const running = await createJob(JobStatus.RUNNING);
      await expect(recorder.claimForAttempt(running, 'exec-x', 1)).resolves.toBe(false);
    });

    it('a re-execution (attemptsStarted 2) re-claims a row a dead execution left RUNNING', async () => {
      // Stall/crash recovery: a stalled job is re-activated with attemptsMade
      // still 0 but attemptsStarted 2 — the claim MUST take the orphaned
      // RUNNING row, or it stays RUNNING forever and the api's active-job
      // dedupe bricks re-enumeration for that channel.
      const jobId = await createJob(JobStatus.RUNNING);
      await expect(recorder.claimForAttempt(jobId, 'exec-2', 2)).resolves.toBe(true);
      const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
      expect(row.status).toBe(JobStatus.RUNNING);
      expect(row.bullJobId).toBe('exec-2'); // refreshed for this execution
      expect(row.attempt).toBe(1); // the row's FIRST recorded execution (0 + 1)
    });

    it('two claims on the same row keep the execution count growing (attempt 2)', async () => {
      const jobId = await createJob(JobStatus.QUEUED);
      await expect(recorder.claimForAttempt(jobId, 'exec-1', 1)).resolves.toBe(true);
      // BullMQ retry of the same execution: attemptsStarted 2 re-claims RUNNING.
      await expect(recorder.claimForAttempt(jobId, 'exec-1', 2)).resolves.toBe(true);
      const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
      expect(row.attempt).toBe(2); // 2 executions total, regardless of bullmq's counter
    });

    it("a RESUME-shaped claim (fresh bull job, attemptsStarted back at 1, row QUEUED again) keeps growing — never resets to bullmq's counter", async () => {
      // P7 resume: the endpoint re-adds a FRESH bull job (same custom jobId,
      // but a brand-new execution whose attemptsStarted restarts at 1). The
      // old formula `attempt = attemptsStarted − 1` would RESET the display
      // count to 0 here; the increment semantics must keep it growing.
      const jobId = await createJob(JobStatus.QUEUED);
      await expect(recorder.claimForAttempt(jobId, 'exec-1', 1)).resolves.toBe(true);
      // pause → resume: the row goes PAUSED, then back to QUEUED.
      await prisma.job.update({ where: { id: jobId }, data: { status: JobStatus.QUEUED } });
      await expect(recorder.claimForAttempt(jobId, 'exec-resume', 1)).resolves.toBe(true);
      const row = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
      expect(row.bullJobId).toBe('exec-resume');
      expect(row.attempt).toBe(2); // execution #2 of the row across pause/resume
    });

    it('a re-execution still refuses terminal rows (canceled mid-backoff stays canceled)', async () => {
      const canceled = await createJob(JobStatus.CANCELED);
      await expect(recorder.claimForAttempt(canceled, 'exec-3', 2)).resolves.toBe(false);
      const row = await prisma.job.findUniqueOrThrow({ where: { id: canceled } });
      expect(row.status).toBe(JobStatus.CANCELED);
    });
  });

  it('markRequeuedForRetry is a RUNNING→QUEUED CAS (transient retry backoff); terminal rows untouched', async () => {
    const running = await createJob(JobStatus.RUNNING);
    await recorder.markRequeuedForRetry(running);
    const requeued = await prisma.job.findUniqueOrThrow({ where: { id: running } });
    expect(requeued.status).toBe(JobStatus.QUEUED);

    const canceled = await createJob(JobStatus.CANCELED);
    await recorder.markRequeuedForRetry(canceled);
    const untouched = await prisma.job.findUniqueOrThrow({ where: { id: canceled } });
    expect(untouched.status).toBe(JobStatus.CANCELED);
  });

  it('markRequeuedForRetry ZEROES the progress fields (v1 stale-bar parity: no stale 87% on a re-queued job)', async () => {
    const row = await prisma.job.create({
      data: {
        type: JobType.DOWNLOAD,
        status: JobStatus.RUNNING,
        progressPct: 42.5,
        downloadedBytes: 1000n,
        totalBytes: 2000n,
        speedBps: 99.5,
        etaSeconds: 12,
        currentFile: '/staging/x.mp4',
      },
    });
    await recorder.markRequeuedForRetry(row.id);
    const after = await prisma.job.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe(JobStatus.QUEUED);
    expect(after.progressPct).toBe(0);
    expect(after.downloadedBytes).toBe(0n);
    expect(after.totalBytes).toBeNull();
    expect(after.speedBps).toBeNull();
    expect(after.etaSeconds).toBeNull();
    expect(after.currentFile).toBeNull();
  });

  it('markFinished FAILED/CANCELED zero the progress fields; COMPLETED keeps its final numbers', async () => {
    const progress = {
      progressPct: 87.5,
      downloadedBytes: 1750n,
      totalBytes: 2000n,
      speedBps: 10.5,
      etaSeconds: 3,
      currentFile: '/staging/y.mp4',
    };
    const failed = await prisma.job.create({
      data: { type: JobType.DOWNLOAD, status: JobStatus.RUNNING, ...progress },
    });
    await recorder.markFinished(failed.id, 'FAILED', { error: 'boom' });
    const failedRow = await prisma.job.findUniqueOrThrow({ where: { id: failed.id } });
    expect(failedRow.progressPct).toBe(0);
    expect(failedRow.downloadedBytes).toBe(0n);
    expect(failedRow.totalBytes).toBeNull();
    expect(failedRow.speedBps).toBeNull();
    expect(failedRow.etaSeconds).toBeNull();
    expect(failedRow.currentFile).toBeNull();

    const canceled = await prisma.job.create({
      data: { type: JobType.DOWNLOAD, status: JobStatus.RUNNING, ...progress },
    });
    await recorder.markFinished(canceled.id, 'CANCELED');
    const canceledRow = await prisma.job.findUniqueOrThrow({ where: { id: canceled.id } });
    expect(canceledRow.progressPct).toBe(0);
    expect(canceledRow.downloadedBytes).toBe(0n);
    expect(canceledRow.currentFile).toBeNull();

    // COMPLETED keeps its final numbers — a finished bar READS 100% (deliberate
    // refinement of v1's 'always clear').
    const completed = await prisma.job.create({
      data: { type: JobType.DOWNLOAD, status: JobStatus.RUNNING, ...progress, progressPct: 100 },
    });
    await recorder.markFinished(completed.id, 'COMPLETED', { summary: 'done' });
    const completedRow = await prisma.job.findUniqueOrThrow({ where: { id: completed.id } });
    expect(completedRow.progressPct).toBe(100);
    expect(completedRow.downloadedBytes).toBe(1750n);
    expect(completedRow.totalBytes).toBe(2000n);
    expect(completedRow.currentFile).toBe('/staging/y.mp4');
  });

  it('markPaused is a RUNNING→PAUSED CAS: false for a non-RUNNING row', async () => {
    const running = await createJob(JobStatus.RUNNING);
    await expect(recorder.markPaused(running)).resolves.toBe(true);
    const paused = await prisma.job.findUniqueOrThrow({ where: { id: running } });
    expect(paused.status).toBe(JobStatus.PAUSED);
    expect(paused.pausedAt).toBeInstanceOf(Date);

    const queued = await createJob(JobStatus.QUEUED);
    await expect(recorder.markPaused(queued)).resolves.toBe(false);
    const untouched = await prisma.job.findUniqueOrThrow({ where: { id: queued } });
    expect(untouched.status).toBe(JobStatus.QUEUED);
  });

  it('markFinished records the terminal status + finishedAt and clears stagingDir only when instructed', async () => {
    const completed = await prisma.job.create({
      data: { type: JobType.ENUMERATE, status: JobStatus.RUNNING, stagingDir: '/staging/a' },
    });
    await recorder.markFinished(completed.id, 'COMPLETED', {
      summary: 'done',
      clearStagingDir: true,
    });
    const doneRow = await prisma.job.findUniqueOrThrow({ where: { id: completed.id } });
    expect(doneRow.status).toBe(JobStatus.COMPLETED);
    expect(doneRow.finishedAt).toBeInstanceOf(Date);
    expect(doneRow.summary).toBe('done');
    expect(doneRow.stagingDir).toBeNull(); // instructed → wiped

    const failed = await prisma.job.create({
      data: { type: JobType.ENUMERATE, status: JobStatus.RUNNING, stagingDir: '/staging/b' },
    });
    await recorder.markFinished(failed.id, 'FAILED', { error: 'boom', errorKind: 'TRANSIENT' });
    const failedRow = await prisma.job.findUniqueOrThrow({ where: { id: failed.id } });
    expect(failedRow.status).toBe(JobStatus.FAILED);
    expect(failedRow.error).toBe('boom');
    expect(failedRow.errorKind).toBe('TRANSIENT');
    expect(failedRow.stagingDir).toBe('/staging/b'); // NOT instructed → kept (pause/resume needs it)
  });

  it('event appends a JobEvent with level, message and context', async () => {
    const jobId = await createJob(JobStatus.RUNNING);
    await recorder.event(jobId, 'INFO', 'started', { attempt: 1 });
    await recorder.event(jobId, 'ERROR', 'stalled');
    const events = await prisma.jobEvent.findMany({
      where: { jobId },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => [e.level, e.message])).toEqual([
      ['INFO', 'started'],
      ['ERROR', 'stalled'],
    ]);
    expect(events[0]?.context).toEqual({ attempt: 1 });
  });

  it('markFinished never overwrites a terminal row: FAILED on a CANCELED row is a quiet no-op', async () => {
    // Control-cancel racing the failure path: the cancel verdict must win —
    // a late markFinished(FAILED/COMPLETED) may not resurrect/flip the row.
    const canceled = await createJob(JobStatus.CANCELED);
    await recorder.markFinished(canceled, 'FAILED', {
      error: 'late loser',
      errorKind: 'TRANSIENT',
    });
    const row = await prisma.job.findUniqueOrThrow({ where: { id: canceled } });
    expect(row.status).toBe(JobStatus.CANCELED);
    expect(row.error).toBeNull(); // the losing write left NO trace

    const completed = await createJob(JobStatus.COMPLETED);
    await recorder.markFinished(completed, 'CANCELED');
    expect((await prisma.job.findUniqueOrThrow({ where: { id: completed } })).status).toBe(
      JobStatus.COMPLETED,
    );
  });

  it('recording never breaks the job: event/markFinished on a missing row are swallowed', async () => {
    await expect(recorder.event('no-such-job', 'INFO', 'ghost')).resolves.toBeUndefined();
    // markFinished reports the CAS truth (false = nothing transitioned) but never throws.
    await expect(recorder.markFinished('no-such-job', 'COMPLETED')).resolves.toBe(false);
  });
});
