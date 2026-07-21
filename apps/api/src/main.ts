import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { configureApp } from './app-setup';
import { API_CONFIG, type ApiConfig } from './config';
import { RedactingConsoleLogger } from './redacting-logger';

async function bootstrap(): Promise<void> {
  // bodyParser off + the SHARED configureApp stack (json 2mb limit + the
  // fixed-shape body-parser error middleware + the /api prefix) — the same
  // pipeline every e2e bootstrap runs, so tests can never drift from prod.
  // Logger at the FACTORY (equivalent to app.useLogger but also covers
  // boot-time lines): every log sweeps through the engine redactor (D7).
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    logger: new RedactingConsoleLogger(),
  });
  configureApp(app);
  app.enableShutdownHooks();
  const config = app.get<ApiConfig>(API_CONFIG);
  await app.listen(config.port);
  new Logger('Bootstrap').log(`api listening on :${config.port}`);
}

bootstrap().catch((err: unknown) => {
  // Fail-closed: a boot error (e.g. missing TUBEVAULT_ACCESS_SECRET_HASH) must
  // kill the process loudly, never leave a half-up server.
  console.error('api failed to boot:', err instanceof Error ? err.message : err);
  process.exit(1);
});
