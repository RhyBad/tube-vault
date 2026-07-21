/**
 * CR-25 one-time backfill CLI — fill `Video.publishedAt` on historical null rows
 * (disk-first, re-probe only lives). Wires the real deps WITHOUT booting the
 * worker's BullMQ consumers/schedulers, so it does its pass and exits.
 *
 * Run once (owner-invoked), e.g. against the prod stack:
 *   docker compose exec worker node dist/scripts/backfill-published-at.js
 *
 * Reads the SAME env as the worker (DATABASE_URL, TUBEVAULT_DATA_DIR,
 * TUBEVAULT_CREDENTIAL_KEY_FILE for members-only VOD cookies, yt-dlp levers).
 * Idempotent: re-running only touches rows still null.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { PrismaClient } from '@tubevault/db';
import { engineConfigFromEnv } from '@tubevault/engine';
import { LocalFileStore } from '@tubevault/storage';

import { loadWorkerConfig } from '../config';
import { NotificationsService } from '../services/notifications.service';
import { EngineVodPublishProbe, PublishedAtBackfill } from '../services/published-at-backfill';
import { SessionService } from '../services/session.service';

async function main(): Promise<void> {
  const logger = new Logger('backfill-published-at');
  const config = loadWorkerConfig(process.env);
  const engine = engineConfigFromEnv(process.env);
  const prisma = new PrismaClient({ datasourceUrl: config.databaseUrl });
  const store = new LocalFileStore(config.vaultRoot);
  const notifications = new NotificationsService(prisma);
  const session = new SessionService(config, prisma, notifications);
  const probe = new EngineVodPublishProbe(engine, session);
  const backfill = new PublishedAtBackfill(prisma, store, probe);

  try {
    const report = await backfill.run({ reprobeLives: true });
    logger.log(
      `done — scanned ${report.scanned}, filledFromDisk ${report.filledFromDisk}, ` +
        `filledFromProbe ${report.filledFromProbe}, skipped ${report.skipped}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('backfill failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
