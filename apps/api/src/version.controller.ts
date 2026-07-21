import { Controller, Get } from '@nestjs/common';

import { Public } from './auth/public.decorator';
import { appVersion, type VersionInfo } from './version';

@Controller('version')
export class VersionController {
  /**
   * Open (unauthenticated) build-identity probe → { version, gitSha, builtAt }.
   * Kept separate from /health so the liveness probe stays a bare {status:'ok'}.
   */
  @Public()
  @Get()
  version(): VersionInfo {
    return appVersion(process.env);
  }
}
