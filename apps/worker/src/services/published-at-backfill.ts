/**
 * CR-25 one-time backfill: fill `Video.publishedAt` on rows that predate the
 * acquisition-time harvest (P1–P4). The forward fix populates publishedAt for
 * every NEW live finalize / recheck / download; this repairs the historical
 * null rows WITHOUT re-enumerating a channel (the flat sweep is deliberately
 * cheap and carries no timestamp — resolving each video there is the bot-wall
 * trap, see PLAN.md CR-25).
 *
 * Strategy (owner decision — "disk-first, re-probe only lives"):
 *   1. DISK FIRST — read the `<id>.info.json` a regular download already wrote
 *      to the video dir (zero network). Covers enumerated-then-downloaded
 *      videos for free.
 *   2. LIVE FALLBACK — a live capture writes no info.json, so a LIVE row with
 *      no usable on-disk metadata is re-probed once via a cookie'd VOD probe.
 *      The loop is SEQUENTIAL (its own throttle) and parked/ended lives are
 *      few, so this never hammers YouTube.
 *
 * Idempotent + safe: every write is an `updateMany WHERE publishedAt IS NULL`,
 * so a second run only touches still-null rows and an existing value is NEVER
 * overwritten (the "never-wipe" half of the CR-25 rule). Display-only field →
 * no `video:changed` frame is emitted; a UI reload surfaces the dates. Run once
 * via the `backfill-published-at` CLI (see scripts/).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseEpochTimestamp, parseUploadDate, publishedAtFromMetadata } from '@tubevault/core';
import type { PrismaClient } from '@tubevault/db';
import { probeVodDuration, type EngineConfig } from '@tubevault/engine';
import type { LocalFileStore } from '@tubevault/storage';

import type { SessionService } from './session.service';

/** The VOD publish-time source for the LIVE fallback (dependency-inverted for tests). */
export interface VodPublishProbe {
  /** The VOD's real publish time, or null when unmeasurable (errored / still processing). */
  publishedAt(videoId: string): Promise<Date | null>;
}

export interface BackfillReport {
  /** null-publishedAt rows examined this run. */
  readonly scanned: number;
  /** filled from the on-disk info.json. */
  readonly filledFromDisk: number;
  /** filled from the LIVE VOD re-probe. */
  readonly filledFromProbe: number;
  /** left null (no disk metadata and not a re-probeable live, or the probe gave nothing). */
  readonly skipped: number;
}

export interface BackfillOptions {
  /** Re-probe LIVE rows that disk couldn't fill (default true). */
  readonly reprobeLives?: boolean;
  /** Cap the rows examined this run (default: all). */
  readonly batchLimit?: number;
}

export class PublishedAtBackfill {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly store: LocalFileStore,
    private readonly probe: VodPublishProbe,
  ) {}

  async run(opts: BackfillOptions = {}): Promise<BackfillReport> {
    const reprobeLives = opts.reprobeLives ?? true;
    const rows = await this.prisma.video.findMany({
      where: { publishedAt: null },
      select: { id: true, channelId: true, contentType: true },
      orderBy: { id: 'asc' }, // deterministic; the loop is the throttle
      ...(opts.batchLimit !== undefined ? { take: opts.batchLimit } : {}),
    });

    let filledFromDisk = 0;
    let filledFromProbe = 0;
    let skipped = 0;
    for (const row of rows) {
      // 1) DISK FIRST — the info.json a regular download already wrote.
      const fromDisk = readPublishedAtFromInfoJson(this.store, row.channelId, row.id);
      if (fromDisk !== null && (await this.fill(row.id, fromDisk))) {
        filledFromDisk += 1;
        continue;
      }
      // 2) LIVE FALLBACK — a live has no info.json; re-probe its VOD once.
      if (reprobeLives && row.contentType === 'LIVE') {
        const fromProbe = await this.probe.publishedAt(row.id);
        if (fromProbe !== null && (await this.fill(row.id, fromProbe))) {
          filledFromProbe += 1;
          continue;
        }
      }
      skipped += 1;
    }
    return { scanned: rows.length, filledFromDisk, filledFromProbe, skipped };
  }

  /**
   * Write publishedAt ONLY while the row is still null — idempotent and it can
   * never overwrite an existing value (the CR-25 "never-wipe" rule) even if a
   * concurrent writer filled it between the scan and here. Returns whether it won.
   */
  private async fill(id: string, publishedAt: Date): Promise<boolean> {
    const { count } = await this.prisma.video.updateMany({
      where: { id, publishedAt: null },
      data: { publishedAt },
    });
    return count > 0;
  }
}

/**
 * Production {@link VodPublishProbe}: a cookie'd metadata-only VOD probe (the
 * same call CR-20 makes for completeness), reused ONLY for the publish time.
 */
export class EngineVodPublishProbe implements VodPublishProbe {
  constructor(
    private readonly engine: EngineConfig,
    private readonly session: SessionService,
  ) {}

  async publishedAt(videoId: string): Promise<Date | null> {
    const cookies = await this.session.cookies();
    try {
      const probe = await probeVodDuration(
        this.engine,
        `https://www.youtube.com/watch?v=${videoId}`,
        cookies.path !== null ? { cookiesFile: cookies.path } : {},
      );
      return probe.publishedAt;
    } finally {
      await cookies.cleanup();
    }
  }
}

/** The on-disk info.json publish time for a video, or null when absent/unparseable. */
export function readPublishedAtFromInfoJson(
  store: LocalFileStore,
  channelId: string,
  videoId: string,
): Date | null {
  const dir = store.existingDir(channelId, videoId);
  if (dir === null) {
    return null;
  }
  let info: unknown;
  try {
    info = JSON.parse(readFileSync(join(dir, `${videoId}.info.json`), 'utf8'));
  } catch {
    return null; // missing / unreadable / unparseable → nothing to harvest
  }
  if (typeof info !== 'object' || info === null) {
    return null;
  }
  const dict = info as Record<string, unknown>;
  return publishedAtFromMetadata(
    parseEpochTimestamp(dict['timestamp']),
    parseUploadDate(dict['upload_date']),
  );
}
