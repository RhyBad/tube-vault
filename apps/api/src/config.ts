import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { loadKeyFile } from '@tubevault/core';
import { registerSecret } from '@tubevault/engine';
import { z } from 'zod';

/** Env mapping (subset of process.env) — injected so config parsing stays deterministic in tests. */
export type EnvMap = Record<string, string | undefined>;

export interface ApiConfig {
  port: number;
  databaseUrl: string;
  redisHost: string;
  redisPort: number;
  /** Argon2 hash of the one dashboard shared secret (never the plaintext). */
  accessSecretHash: string;
  /** HMAC key for the tv_session cookie. */
  sessionKey: string;
  /** Secure cookie flag; v1 parity: ON unless TUBEVAULT_INSECURE_COOKIES is truthy. */
  cookieSecure: boolean;
  /**
   * Deadline for the SYNC yt-dlp extractions (register/add-url): a wedged
   * child must not hang the HTTP request forever (the runner group-kills on
   * abort; the caller answers 504 TRANSIENT).
   */
  syncExtractTimeoutMs: number;
  /** All derived paths hang off this (worker-config parity: TUBEVAULT_DATA_DIR, default /data). */
  dataDir: string;
  /**
   * Where preserved media lives: `<dataDir>/media`. The api needs it for the
   * cancel endpoint's staging wipe (a stagingDir outside this root is NEVER
   * rm'd) and for P9 media serving.
   */
  vaultRoot: string;
  /**
   * The 32-byte AES-256-GCM credential key (P8), loaded + validated at boot
   * from TUBEVAULT_CREDENTIAL_KEY_FILE. `undefined` = the env is unset and the
   * whole session feature is DISABLED (PUT/DELETE /api/session answer 503); a
   * SET-but-broken key file fails the boot instead (fail-closed — a silently
   * disabled session feature would look like an owner error).
   */
  credentialKey?: Uint8Array;
}

/** Nest DI token for the parsed config. */
export const API_CONFIG = Symbol('API_CONFIG');

/**
 * v1 parity (config.py _read_secret): a secret comes inline from `<name>` or
 * from the file at `<name>_FILE` (mounted secret). Undefined when neither is set.
 */
function readSecret(env: EnvMap, name: string): string | undefined {
  const direct = (env[name] ?? '').trim();
  if (direct) return direct;
  const file = (env[`${name}_FILE`] ?? '').trim();
  if (file) return readFileSync(file, 'utf8').trim();
  return undefined;
}

const portSchema = (name: string, fallback: number) =>
  z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw.trim() === '') return fallback;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${name} must be a port number` });
        return z.NEVER;
      }
      return n;
    });

const envSchema = z.object({
  API_PORT: portSchema('API_PORT', 3000),
  DATABASE_URL: z
    .string({ required_error: 'DATABASE_URL is required' })
    .min(1, 'DATABASE_URL is required'),
  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: portSchema('REDIS_PORT', 6379),
  // The access gate is ON by default: refuse to serve without its secrets rather
  // than come up open (v1 build_access_gate fail-closed semantics).
  TUBEVAULT_ACCESS_SECRET_HASH: z
    .string({ required_error: 'TUBEVAULT_ACCESS_SECRET_HASH is required (argon2 hash)' })
    .min(1, 'TUBEVAULT_ACCESS_SECRET_HASH is required (argon2 hash)'),
  TUBEVAULT_SESSION_KEY: z
    .string({ required_error: 'TUBEVAULT_SESSION_KEY is required (>= 32 chars)' })
    .min(32, 'TUBEVAULT_SESSION_KEY must be at least 32 characters'),
  TUBEVAULT_INSECURE_COOKIES: z.string().optional(),
  TUBEVAULT_SYNC_EXTRACT_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw.trim() === '') return 300_000; // 5 min default
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'TUBEVAULT_SYNC_EXTRACT_TIMEOUT_MS must be a positive integer (milliseconds)',
        });
        return z.NEVER;
      }
      return n;
    }),
  // Worker-config parity (v1 config.py): default '/data', blank falls back,
  // MUST be absolute (a relative root would make wipe-safety cwd-dependent).
  TUBEVAULT_DATA_DIR: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const dir = (raw ?? '').trim() || '/data';
      if (!isAbsolute(dir)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `TUBEVAULT_DATA_DIR must be an absolute path: ${dir}`,
        });
        return z.NEVER;
      }
      return dir;
    }),
});

/**
 * Parse + validate the environment into a typed config. THROWS on anything
 * missing/invalid — the api must refuse to boot rather than run unauthenticated
 * (fail-closed). Secrets accept v1's `*_FILE` mounted-secret variants.
 */
export function loadApiConfig(env: EnvMap): ApiConfig {
  const resolved: EnvMap = {
    ...env,
    TUBEVAULT_ACCESS_SECRET_HASH: readSecret(env, 'TUBEVAULT_ACCESS_SECRET_HASH'),
    TUBEVAULT_SESSION_KEY: readSecret(env, 'TUBEVAULT_SESSION_KEY'),
  };
  const parsed = envSchema.safeParse(resolved);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
    throw new Error(`invalid api configuration — refusing to boot: ${details}`);
  }
  const e = parsed.data;
  const insecure = (e.TUBEVAULT_INSECURE_COOKIES ?? '').trim().toLowerCase();
  const credentialKey = loadCredentialKey(env);
  return {
    port: e.API_PORT,
    databaseUrl: e.DATABASE_URL,
    redisHost: e.REDIS_HOST,
    redisPort: e.REDIS_PORT,
    accessSecretHash: e.TUBEVAULT_ACCESS_SECRET_HASH,
    sessionKey: e.TUBEVAULT_SESSION_KEY,
    cookieSecure: !['1', 'true', 'yes', 'on'].includes(insecure),
    syncExtractTimeoutMs: e.TUBEVAULT_SYNC_EXTRACT_TIMEOUT_MS,
    dataDir: e.TUBEVAULT_DATA_DIR,
    vaultRoot: join(e.TUBEVAULT_DATA_DIR, 'media'),
    ...(credentialKey !== undefined ? { credentialKey } : {}),
  };
}

/**
 * P8: the optional owner-session credential key. Unset env = feature disabled
 * (undefined). Set = load + validate NOW (core loadKeyFile: strict base64,
 * exactly 32 bytes) and register the ENCODED key text for log redaction —
 * fail-closed on anything malformed/unreadable, so the api never boots with a
 * half-working session feature.
 */
function loadCredentialKey(env: EnvMap): Uint8Array | undefined {
  const path = (env['TUBEVAULT_CREDENTIAL_KEY_FILE'] ?? '').trim();
  if (!path) {
    return undefined;
  }
  try {
    const loaded = loadKeyFile(path);
    registerSecret(loaded.encoded); // mask the key text wherever it might surface
    return loaded.key;
  } catch (err) {
    throw new Error(
      `invalid api configuration — refusing to boot: TUBEVAULT_CREDENTIAL_KEY_FILE: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
