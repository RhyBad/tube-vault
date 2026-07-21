/**
 * Settings-driven download concurrency (PLAN.md queue mechanics): the worker
 * re-reads the Settings singleton at EACH pickup and live-assigns
 * `worker.concurrency` — so an owner edit takes effect on the very next job,
 * no restart. Clamped to [1,4]; the serial default 1 is a bot-wall lever
 * (fewer simultaneous requests is gentler on YouTube).
 */
import type { PrismaClient, Settings } from '@tubevault/db';
import { CONCURRENCY_MAX, CONCURRENCY_MIN } from '@tubevault/types';

// Re-exported for existing consumers; DEFINED in @tubevault/types so the api's
// settings PATCH clamp and this per-pickup clamp can never drift.
export { CONCURRENCY_MAX, CONCURRENCY_MIN };

/** Clamp to [1,4]; garbage (NaN/∞) degrades to the safe serial default 1. */
export function clampConcurrency(value: number): number {
  if (!Number.isFinite(value)) {
    return CONCURRENCY_MIN;
  }
  return Math.min(CONCURRENCY_MAX, Math.max(CONCURRENCY_MIN, Math.trunc(value)));
}

/**
 * Read (create-if-missing, schema defaults) the Settings singleton and derive
 * the clamped concurrency. Returns the raw row too — the download processor
 * reuses it for policy resolution (one read per pickup).
 */
export async function readDownloadConcurrency(
  prisma: Pick<PrismaClient, 'settings'>,
): Promise<{ settings: Settings; concurrency: number }> {
  const settings = await prisma.settings.upsert({
    where: { id: 'singleton' },
    update: {},
    create: {},
  });
  return { settings, concurrency: clampConcurrency(settings.downloadConcurrency) };
}
