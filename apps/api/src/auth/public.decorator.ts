import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'tubevault:is_public';

/**
 * Marks a route/controller as reachable WITHOUT a session cookie. Only
 * /api/health and /api/auth/login carry this — everything else is guarded.
 */
export const Public = (): CustomDecorator => SetMetadata(IS_PUBLIC_KEY, true);
