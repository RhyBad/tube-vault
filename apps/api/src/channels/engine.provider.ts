import type { Provider } from '@nestjs/common';
import { engineConfigFromEnv, type EngineConfig } from '@tubevault/engine';

/** Nest DI token for the yt-dlp engine config used by sync extractions. */
export const ENGINE_CONFIG = Symbol('ENGINE_CONFIG');

/**
 * Engine config from the process env — the SAME entrypoint the worker uses, so
 * TUBEVAULT_YTDLP_BIN (fake fixture in tests, real binary in prod) and every
 * bot-wall lever (throttle/proxy/player_client/POT) are honored in the api's
 * synchronous flat-extract and metadata calls too.
 */
export const engineConfigProvider: Provider = {
  provide: ENGINE_CONFIG,
  useFactory: (): EngineConfig => engineConfigFromEnv(process.env),
};
