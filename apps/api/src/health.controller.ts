import { Controller, Get } from '@nestjs/common';

import { Public } from './auth/public.decorator';

@Controller('health')
export class HealthController {
  /** Open (unauthenticated) liveness probe — compose healthchecks poll it. */
  @Public()
  @Get()
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
