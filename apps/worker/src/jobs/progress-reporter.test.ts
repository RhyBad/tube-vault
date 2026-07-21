/**
 * Coalesced download progress (PLAN.md: `job:progress` ≤4Hz per job over Redis;
 * row persistence ≤0.5Hz; the FINAL frame always flushed to both).
 */
import { describe, expect, it } from 'vitest';

import { ProgressReporter } from './progress-reporter';

function frameLine(downloaded: number, total = 2048): string {
  return `TVPROG1 ${JSON.stringify({
    status: 'downloading',
    downloaded_bytes: downloaded,
    total_bytes: total,
    speed: 100,
    eta: 3,
    filename: '/staging/vid.mp4',
  })}`;
}

interface Captured {
  publishes: { channel: string; payload: unknown }[];
  persists: unknown[];
}

function reporter(now: () => number): { r: ProgressReporter; captured: Captured } {
  const captured: Captured = { publishes: [], persists: [] };
  const publisher = {
    publish: (channel: string, payload: unknown) => {
      captured.publishes.push({ channel, payload });
      return Promise.resolve();
    },
  };
  const prisma = {
    job: {
      update: (args: unknown) => {
        captured.persists.push(args);
        return Promise.resolve({});
      },
    },
  };
  const r = new ProgressReporter(
    {
      jobId: 'job1',
      videoId: 'vid1',
      publisher: publisher as never,
      prisma: prisma as never,
    },
    now,
  );
  return { r, captured };
}

describe('ProgressReporter (≤4Hz publish, ≤0.5Hz persist, final flush)', () => {
  it('publishes the first frame immediately, then coalesces bursts to ≤4Hz', async () => {
    let t = 0;
    const { r, captured } = reporter(() => t);
    r.onLine(frameLine(100)); // t=0 → published
    t = 50;
    r.onLine(frameLine(200)); // within 250ms → coalesced
    t = 100;
    r.onLine(frameLine(300)); // still coalesced
    t = 260;
    r.onLine(frameLine(400)); // > 250ms since last publish → published
    await r.settle();
    expect(captured.publishes).toHaveLength(2);
    expect(captured.publishes[0]!.channel).toBe('job:progress');
    expect(captured.publishes[0]!.payload).toMatchObject({
      jobId: 'job1',
      videoId: 'vid1',
      downloadedBytes: 100,
      totalBytes: 2048,
    });
    expect(captured.publishes[1]!.payload).toMatchObject({ downloadedBytes: 400 });
  });

  it('persists at ≤0.5Hz (2s min interval), independent of the publish cadence', async () => {
    let t = 0;
    const { r, captured } = reporter(() => t);
    r.onLine(frameLine(100)); // t=0 → persisted
    t = 500;
    r.onLine(frameLine(200)); // published, NOT persisted (within 2s)
    t = 2100;
    r.onLine(frameLine(300)); // > 2s → persisted
    await r.settle();
    expect(captured.persists).toHaveLength(2);
    expect(captured.persists[1]).toMatchObject({
      where: { id: 'job1' },
      data: {
        progressPct: expect.closeTo((300 / 2048) * 100, 3) as number,
        downloadedBytes: 300n,
        totalBytes: 2048n,
        speedBps: 100,
        etaSeconds: 3,
        currentFile: '/staging/vid.mp4',
      },
    });
  });

  it('flush() always emits the LATEST frame to both sinks, even mid-window', async () => {
    let t = 0;
    const { r, captured } = reporter(() => t);
    r.onLine(frameLine(100));
    t = 10;
    r.onLine(frameLine(2048)); // coalesced away…
    await r.flush(); // …but the final frame must never be lost
    expect(captured.publishes.at(-1)!.payload).toMatchObject({ downloadedBytes: 2048 });
    expect(captured.persists.at(-1)).toMatchObject({
      data: expect.objectContaining({ downloadedBytes: 2048n }) as unknown,
    });
  });

  it('non-progress lines and garbage are ignored; flush with no frames is a no-op', async () => {
    const { r, captured } = reporter(() => 0);
    r.onLine('[download] Destination: /x.mp4');
    r.onLine('TVPROG1 not-json');
    await r.flush();
    expect(captured.publishes).toHaveLength(0);
    expect(captured.persists).toHaveLength(0);
  });

  it('settled sink writes are DROPPED as they settle: the pending set stays bounded over a long download', async () => {
    // A multi-hour download at 4Hz would otherwise accumulate tens of
    // thousands of settled promises until the final flush.
    let t = 0;
    const { r } = reporter(() => t);
    for (let i = 0; i < 200; i++) {
      t += 2_100; // beyond BOTH throttles → every line publishes AND persists
      r.onLine(frameLine(i + 1));
      await new Promise((resolve) => setImmediate(resolve)); // let settled writes detach
    }
    expect(r.pendingCount).toBe(0); // everything settled → nothing retained
  });

  it('pct is 0 when total is unknown (never NaN)', async () => {
    const { r, captured } = reporter(() => 0);
    r.onLine(
      `TVPROG1 ${JSON.stringify({ status: 'downloading', downloaded_bytes: 10, speed: null })}`,
    );
    await r.settle();
    expect(captured.publishes[0]!.payload).toMatchObject({ pct: 0, totalBytes: null });
  });

  it('reset() publishes + persists a ZEROED frame unconditionally and clears the latest (P7 scratch restart)', async () => {
    // The unresumable→scratch path wipes staging mid-execution: the bar must
    // snap back to 0 immediately (no throttle window) and a later flush() must
    // NOT resurrect the pre-wipe frame.
    let t = 0;
    const { r, captured } = reporter(() => t);
    r.onLine(frameLine(1024)); // t=0 → published + persisted (50%)
    t = 10; // WITHIN both throttle windows — reset must bypass them
    await r.reset();
    expect(captured.publishes.at(-1)!.payload).toMatchObject({
      jobId: 'job1',
      videoId: 'vid1',
      pct: 0,
      downloadedBytes: 0,
      totalBytes: null,
      speedBps: null,
      etaSeconds: null,
      currentFile: null,
    });
    expect(captured.persists.at(-1)).toMatchObject({
      data: expect.objectContaining({ progressPct: 0, downloadedBytes: 0n }) as unknown,
    });
    const countAfterReset = captured.publishes.length;
    await r.flush(); // latest cleared → nothing to re-emit
    expect(captured.publishes.length).toBe(countAfterReset);
  });
});
