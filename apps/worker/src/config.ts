import { isAbsolute, join } from 'node:path';

import { loadKeyFile } from '@tubevault/core';
import { registerSecret } from '@tubevault/engine';
import { z } from 'zod';

/** Env mapping (subset of process.env) — injected so config parsing stays deterministic in tests. */
export type EnvMap = Record<string, string | undefined>;

export type WorkerRole = 'archive' | 'live';

export interface WorkerConfig {
  /** Which consumer set this replica runs (PLAN.md: two services from one app). */
  role: WorkerRole;
  databaseUrl: string;
  redisHost: string;
  redisPort: number;
  /** All derived paths hang off this (v1 config.py: TUBEVAULT_DATA_DIR, default /data). */
  dataDir: string;
  /** Where preserved media lives: `<dataDir>/media` (v1 Settings.vault_root parity). */
  vaultRoot: string;
  /**
   * The 32-byte AES-256-GCM credential key (P8), loaded + validated at boot
   * from TUBEVAULT_CREDENTIAL_KEY_FILE (api parity). `undefined` = env unset →
   * the session feature is DISABLED (all jobs run cookie-less); a SET-but-
   * broken key file fails the boot instead (fail-closed).
   */
  credentialKey?: Uint8Array;
  /** CR-09: re-enumeration scheduler tick period (default 6h) + per-tick channel cap. */
  reenumerateEveryMs: number;
  reenumerateBatchLimit: number;
  /** CR-09 source re-check: scheduler tick period (default 5m) + per-video re-check cadence (default 7d). */
  sourceRecheckScanEveryMs: number;
  sourceRecheckIntervalMs: number;
  /** Per source-recheck tick video cap + consecutive-gone confirmations to confirm + probe concurrency. */
  sourceRecheckBatchLimit: number;
  sourceRecheckStreakThreshold: number;
  sourceCheckConcurrency: number;
  /** CR-20 completeness re-check sweep (archive role): scan tick period (default 5m) + per-tick video cap. */
  completenessScanEveryMs: number;
  completenessCheckBatchLimit: number;
}

/** Nest DI token for the parsed config. */
export const WORKER_CONFIG = Symbol('WORKER_CONFIG');

/**
 * A positive-integer env field with a default (blank/unset → fallback). Mirrors
 * the REDIS_PORT transform; shared by the CR-09 cadence knobs so their parsing
 * can't drift.
 */
function positiveIntEnv(
  fallback: number,
  opts: { name: string; min?: number; max?: number },
): z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined> {
  const { name, min = 1, max = Number.MAX_SAFE_INTEGER } = opts;
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw.trim() === '') return fallback;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${name} must be an integer in [${min}, ${max}]`,
        });
        return z.NEVER;
      }
      return n;
    });
}

const envSchema = z.object({
  // Explicit — a worker that silently defaulted its role could double-consume a
  // queue and break the "downloads never interrupt live capture" guarantee.
  WORKER_ROLE: z.enum(['archive', 'live'], {
    required_error: "WORKER_ROLE is required ('archive' | 'live')",
    invalid_type_error: "WORKER_ROLE must be 'archive' or 'live'",
  }),
  DATABASE_URL: z
    .string({ required_error: 'DATABASE_URL is required' })
    .min(1, 'DATABASE_URL is required'),
  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw.trim() === '') return 6379;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'REDIS_PORT must be a port number' });
        return z.NEVER;
      }
      return n;
    }),
  // v1 config.py parity: default '/data', blank falls back, MUST be absolute
  // (a relative vault root would silently scatter media under the worker cwd).
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
  // CR-09 re-enumeration cadence (archive role). Default 6h; a large channel
  // list amortizes across ticks via the batch cap (bot-wall posture).
  REENUMERATE_EVERY_MS: positiveIntEnv(6 * 60 * 60_000, { name: 'REENUMERATE_EVERY_MS' }),
  REENUMERATE_BATCH_LIMIT: positiveIntEnv(50, { name: 'REENUMERATE_BATCH_LIMIT' }),
  // CR-09 source re-check (archive role). The scan ticks every 5m and fans out
  // due held videos; each video is re-checked at most every 7d (the cadence
  // cursor), batch-capped per tick. The streak threshold gates confirmation of a
  // gone original (>= N consecutive definite-gone probes). Probe concurrency 1
  // keeps YouTube traffic gentle (bot-wall posture).
  SOURCE_RECHECK_SCAN_EVERY_MS: positiveIntEnv(5 * 60_000, {
    name: 'SOURCE_RECHECK_SCAN_EVERY_MS',
  }),
  SOURCE_RECHECK_INTERVAL_MS: positiveIntEnv(7 * 24 * 60 * 60_000, {
    name: 'SOURCE_RECHECK_INTERVAL_MS',
  }),
  SOURCE_RECHECK_BATCH_LIMIT: positiveIntEnv(50, { name: 'SOURCE_RECHECK_BATCH_LIMIT' }),
  SOURCE_RECHECK_STREAK_THRESHOLD: positiveIntEnv(2, { name: 'SOURCE_RECHECK_STREAK_THRESHOLD' }),
  SOURCE_CHECK_CONCURRENCY: positiveIntEnv(1, { name: 'SOURCE_CHECK_CONCURRENCY', max: 4 }),
  // CR-20 completeness re-check sweep (archive role). The scan ticks every 5m and
  // resolves due AWAITING_VERIFY captures in place (the per-video re-check cadence
  // + ~24h deadline live in core: completenessRecheckDelayMs / COMPLETENESS_DEADLINE_MS),
  // batch-capped per tick.
  COMPLETENESS_CHECK_SCAN_EVERY_MS: positiveIntEnv(5 * 60_000, {
    name: 'COMPLETENESS_CHECK_SCAN_EVERY_MS',
  }),
  COMPLETENESS_CHECK_BATCH_LIMIT: positiveIntEnv(50, { name: 'COMPLETENESS_CHECK_BATCH_LIMIT' }),
});

/** Parse + validate the environment. THROWS on missing/invalid values (fail-closed boot). */
export function loadWorkerConfig(env: EnvMap): WorkerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
    throw new Error(`invalid worker configuration — refusing to boot: ${details}`);
  }
  const credentialKey = loadCredentialKey(env);
  return {
    role: parsed.data.WORKER_ROLE,
    databaseUrl: parsed.data.DATABASE_URL,
    redisHost: parsed.data.REDIS_HOST,
    redisPort: parsed.data.REDIS_PORT,
    dataDir: parsed.data.TUBEVAULT_DATA_DIR,
    vaultRoot: join(parsed.data.TUBEVAULT_DATA_DIR, 'media'),
    reenumerateEveryMs: parsed.data.REENUMERATE_EVERY_MS,
    reenumerateBatchLimit: parsed.data.REENUMERATE_BATCH_LIMIT,
    sourceRecheckScanEveryMs: parsed.data.SOURCE_RECHECK_SCAN_EVERY_MS,
    sourceRecheckIntervalMs: parsed.data.SOURCE_RECHECK_INTERVAL_MS,
    sourceRecheckBatchLimit: parsed.data.SOURCE_RECHECK_BATCH_LIMIT,
    sourceRecheckStreakThreshold: parsed.data.SOURCE_RECHECK_STREAK_THRESHOLD,
    sourceCheckConcurrency: parsed.data.SOURCE_CHECK_CONCURRENCY,
    completenessScanEveryMs: parsed.data.COMPLETENESS_CHECK_SCAN_EVERY_MS,
    completenessCheckBatchLimit: parsed.data.COMPLETENESS_CHECK_BATCH_LIMIT,
    ...(credentialKey !== undefined ? { credentialKey } : {}),
  };
}

/**
 * P8: the optional owner-session credential key (api-config parity). Unset =
 * feature disabled; set = load + validate NOW (core loadKeyFile) and register
 * the ENCODED key text for log redaction — fail-closed on anything broken.
 */
function loadCredentialKey(env: EnvMap): Uint8Array | undefined {
  const path = (env['TUBEVAULT_CREDENTIAL_KEY_FILE'] ?? '').trim();
  if (!path) {
    return undefined;
  }
  try {
    const loaded = loadKeyFile(path);
    registerSecret(loaded.encoded);
    return loaded.key;
  } catch (err) {
    throw new Error(
      `invalid worker configuration — refusing to boot: TUBEVAULT_CREDENTIAL_KEY_FILE: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
