import { Controller, Get, Inject } from '@nestjs/common';
import type { StorageStatsResponse } from '@tubevault/types';

import { StorageService } from './storage.service';

/**
 * `GET /api/storage` (CR-01): read-only vault capacity + per-channel usage.
 * Session-guarded by the global APP_GUARD (no `@Public`), like every other
 * dashboard route.
 */
@Controller('storage')
export class StorageController {
  constructor(@Inject(StorageService) private readonly storage: StorageService) {}

  @Get()
  stats(): Promise<StorageStatsResponse> {
    return this.storage.stats();
  }
}
