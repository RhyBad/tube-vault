import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@tubevault/db';

import { WORKER_CONFIG, type WorkerConfig } from './config';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  constructor(@Inject(WORKER_CONFIG) config: WorkerConfig) {
    super({ datasourceUrl: config.databaseUrl });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  // onApplicationShutdown (NOT onModuleDestroy): the consumers' onModuleDestroy
  // drain (requeue rows, publish frames) still needs the DB; Nest runs the
  // phases sequentially, so this disconnect happens strictly after the drain.
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
