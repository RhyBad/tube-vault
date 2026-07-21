import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { WORKER_CONFIG, type WorkerConfig } from './config';
import { RedactingConsoleLogger } from './redacting-logger';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  // Standalone context (no HTTP server): the worker is a background consumer.
  // Logger at the factory: every log line (incl. every `new Logger(ctx)` in
  // the consumers) sweeps through the engine redactor (D7) — cookie values /
  // channel secrets in engine stderr can never print raw.
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: new RedactingConsoleLogger(),
  });
  app.enableShutdownHooks();
  const config = app.get<WorkerConfig>(WORKER_CONFIG);
  new Logger('Bootstrap').log(`worker started (role=${config.role})`);
  // The event loop is kept alive by KeepAliveService (worker.module.ts), whose
  // shutdown hook CLEARS the interval so the loop drains after SIGTERM/SIGINT.
  // That drain is what actually ends the process when node runs as PID 1
  // (Nest's post-hook signal re-raise is a kernel no-op for PID 1) — see
  // test/worker-shutdown.e2e.test.ts.
}

bootstrap().catch((err: unknown) => {
  // Fail-closed: a boot error (e.g. missing WORKER_ROLE) must kill the process
  // loudly so compose/systemd surfaces it — never a half-up worker.
  console.error('worker failed to boot:', err instanceof Error ? err.message : err);
  process.exit(1);
});
