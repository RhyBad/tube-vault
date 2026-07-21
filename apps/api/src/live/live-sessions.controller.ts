import { Controller, Get, Inject } from '@nestjs/common';
import type { LiveSessionListResponse } from '@tubevault/types';

import { LiveSessionsService } from './live-sessions.service';

/**
 * `GET /api/live-sessions` (EP-35): read-only snapshot of the active live
 * sessions. Session-guarded by the global APP_GUARD (no `@Public`), like every
 * other dashboard route. Realtime updates arrive as `live.changed` SSE frames
 * on `GET /api/events`; this endpoint just seeds the initial state.
 */
@Controller('live-sessions')
export class LiveSessionsController {
  constructor(@Inject(LiveSessionsService) private readonly live: LiveSessionsService) {}

  @Get()
  list(): Promise<LiveSessionListResponse> {
    return this.live.listActive();
  }
}
