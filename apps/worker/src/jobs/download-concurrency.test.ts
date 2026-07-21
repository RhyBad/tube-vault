/**
 * Settings-driven download concurrency (PLAN.md queue mechanics): re-read from
 * the Settings singleton at EACH pickup, clamped to [1,4], assigned live onto
 * the BullMQ worker (`worker.concurrency` supports reassignment).
 */
import { describe, expect, it } from 'vitest';

import { clampConcurrency, readDownloadConcurrency } from './download-concurrency';

describe('clampConcurrency ([1,4], default 1)', () => {
  it('passes the sane range through', () => {
    expect(clampConcurrency(1)).toBe(1);
    expect(clampConcurrency(2)).toBe(2);
    expect(clampConcurrency(4)).toBe(4);
  });

  it('clamps below 1 up to 1 (serial default is the bot-wall posture)', () => {
    expect(clampConcurrency(0)).toBe(1);
    expect(clampConcurrency(-3)).toBe(1);
  });

  it('clamps above 4 down to 4', () => {
    expect(clampConcurrency(5)).toBe(4);
    expect(clampConcurrency(99)).toBe(4);
  });

  it('non-finite / fractional garbage degrades to the safe default 1', () => {
    expect(clampConcurrency(Number.NaN)).toBe(1);
    expect(clampConcurrency(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampConcurrency(2.7)).toBe(2); // trunc, never round up a concurrency
  });
});

describe('readDownloadConcurrency (Settings singleton, create-if-missing)', () => {
  function fakePrisma(downloadConcurrency: number) {
    const calls: unknown[] = [];
    return {
      calls,
      settings: {
        upsert: (args: unknown) => {
          calls.push(args);
          return Promise.resolve({
            id: 'singleton',
            downloadConcurrency,
            qualityCap: 'UNLIMITED',
            subtitleMode: 'BOTH',
          });
        },
      },
    };
  }

  it('upserts the singleton row (missing → created with defaults) and returns settings + clamp', async () => {
    const prisma = fakePrisma(9);
    const { settings, concurrency } = await readDownloadConcurrency(
      prisma as unknown as Parameters<typeof readDownloadConcurrency>[0],
    );
    expect(concurrency).toBe(4); // 9 clamped down
    expect(settings.downloadConcurrency).toBe(9); // raw row untouched
    expect(prisma.calls).toEqual([
      { where: { id: 'singleton' }, update: {}, create: {} }, // create-if-missing w/ schema defaults
    ]);
  });

  it('default row (1) stays 1', async () => {
    const prisma = fakePrisma(1);
    const { concurrency } = await readDownloadConcurrency(
      prisma as unknown as Parameters<typeof readDownloadConcurrency>[0],
    );
    expect(concurrency).toBe(1);
  });
});
