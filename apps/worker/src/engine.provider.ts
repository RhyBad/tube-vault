import type { Provider } from '@nestjs/common';
import { engineConfigFromEnv, type EngineConfig } from '@tubevault/engine';

/** Nest DI token for the worker's yt-dlp engine config. */
export const ENGINE_CONFIG = Symbol('ENGINE_CONFIG');

/**
 * Engine config from the process env — the same entrypoint the api uses.
 * TUBEVAULT_YTDLP_BIN: the prod worker image runs the real yt-dlp on PATH;
 * tests point it at the committed fake fixture. Every bot-wall lever
 * (throttle/proxy/player_client/POT) is honored on worker extractions too.
 */
export const engineConfigProvider: Provider = {
  provide: ENGINE_CONFIG,
  useFactory: (): EngineConfig => engineConfigFromEnv(process.env),
};
