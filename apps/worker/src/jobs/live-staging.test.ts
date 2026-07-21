/**
 * Live staging prior-attempt preservation (P10 continuation loop) — the
 * v2-native port of v1's per-attempt staging dirs (live_capture.py:284-287:
 * "a crash-resume records into its own dir, so it can never clobber the
 * partial the crashed attempt left behind"). v2 keeps ONE staging dir and
 * renames a prior attempt's media aside to `prior-<epochms>-<origname>`
 * before the fresh yt-dlp spawns; the retained-file scan and the largest-
 * file publication consider those preserved files (v1 _find_media parity:
 * the LARGEST single file wins).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  liveMediaBytes,
  preservePriorAttempt,
  reclaimSupersededPriors,
  resolveLiveCaptureArtifacts,
} from './live-staging';

const VIDEO = 'stagevid001';
let dirs: string[] = [];

function staging(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tv-live-staging-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

describe('preservePriorAttempt (capture start — before the fresh yt-dlp spawns)', () => {
  it('renames a prior attempt’s MEDIA aside to prior-<epochms>-<origname> (bytes survive the fresh run)', () => {
    const dir = staging();
    writeFileSync(join(dir, `${VIDEO}.mp4`), Buffer.alloc(4096, 7));
    const preserved = preservePriorAttempt(dir, VIDEO);
    expect(preserved).toBe(1);
    const names = readdirSync(dir);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(new RegExp(`^prior-\\d+-${VIDEO}\\.mp4$`));
  });

  it('leaves sidecars in place (a fresh run rewrites them) and never re-preserves prior-* files', () => {
    const dir = staging();
    writeFileSync(join(dir, `${VIDEO}.info.json`), '{}');
    writeFileSync(join(dir, `prior-1111-${VIDEO}.mp4`), Buffer.alloc(1024, 7));
    expect(preservePriorAttempt(dir, VIDEO)).toBe(0);
    expect(readdirSync(dir).sort()).toEqual([`prior-1111-${VIDEO}.mp4`, `${VIDEO}.info.json`]);
  });

  it('is a no-op on a missing/empty staging dir', () => {
    const dir = staging();
    expect(preservePriorAttempt(dir, VIDEO)).toBe(0);
    expect(preservePriorAttempt(join(dir, 'nope'), VIDEO)).toBe(0);
  });
});

describe('liveMediaBytes with preserved prior files', () => {
  it('counts prior-preserved media (the retained-file scan must see a continuation partial)', () => {
    const dir = staging();
    writeFileSync(join(dir, `prior-2222-${VIDEO}.mp4`), Buffer.alloc(2048, 7));
    expect(liveMediaBytes(dir, VIDEO)).toBe(2048);
  });

  it('sums fresh + prior media but never prior sidecars', () => {
    const dir = staging();
    writeFileSync(join(dir, `${VIDEO}.mp4`), Buffer.alloc(1024, 7));
    writeFileSync(join(dir, `prior-2222-${VIDEO}.mp4`), Buffer.alloc(2048, 7));
    writeFileSync(join(dir, `prior-2222-${VIDEO}.info.json`), '{"big": "sidecar"}');
    expect(liveMediaBytes(dir, VIDEO)).toBe(3072);
  });
});

describe('resolveLiveCaptureArtifacts with preserved prior files (largest single file wins — v1 parity)', () => {
  it('a LARGER prior partial beats a smaller fresh one and publishes under its ORIGINAL name', () => {
    const dir = staging();
    writeFileSync(join(dir, `${VIDEO}.mp4`), Buffer.alloc(1024, 7));
    writeFileSync(join(dir, `prior-3333-${VIDEO}.mp4`), Buffer.alloc(8192, 7));
    const artifacts = resolveLiveCaptureArtifacts(dir, VIDEO);
    expect(artifacts.mediaPath).toBe(join(dir, `prior-3333-${VIDEO}.mp4`));
    expect(artifacts.mediaExt).toBe('mp4');
    expect(artifacts.mediaPublishName).toBe(`${VIDEO}.mp4`); // prior- prefix never leaves staging
  });

  it('a LARGER fresh recording beats the preserved prior (the continuation captured more)', () => {
    const dir = staging();
    writeFileSync(join(dir, `${VIDEO}.mp4`), Buffer.alloc(8192, 7));
    writeFileSync(join(dir, `prior-3333-${VIDEO}.mp4`), Buffer.alloc(1024, 7));
    const artifacts = resolveLiveCaptureArtifacts(dir, VIDEO);
    expect(artifacts.mediaPath).toBe(join(dir, `${VIDEO}.mp4`));
    expect(artifacts.mediaPublishName).toBe(`${VIDEO}.mp4`);
  });

  it('fresh sidecars ride along; prior sidecars never publish', () => {
    const dir = staging();
    writeFileSync(join(dir, `${VIDEO}.mp4`), Buffer.alloc(1024, 7));
    writeFileSync(join(dir, `${VIDEO}.info.json`), '{}');
    writeFileSync(join(dir, `prior-4444-${VIDEO}.info.json`), '{}');
    const artifacts = resolveLiveCaptureArtifacts(dir, VIDEO);
    expect(artifacts.sidecarPaths).toEqual([join(dir, `${VIDEO}.info.json`)]);
  });

  it('EMPTY-with-prior-bytes is NOT empty: prior-only staging still resolves media', () => {
    const dir = staging();
    writeFileSync(join(dir, `prior-5555-${VIDEO}.mp4`), Buffer.alloc(2048, 7));
    const artifacts = resolveLiveCaptureArtifacts(dir, VIDEO);
    expect(artifacts.mediaPath).not.toBeNull();
    expect(artifacts.mediaPublishName).toBe(`${VIDEO}.mp4`);
  });
});

describe('reclaimSupersededPriors (CR-24 — drop a redundant prior once the current attempt surpasses it)', () => {
  it('reclaims a prior generation the current attempt has surpassed; current file untouched', () => {
    const dir = staging();
    writeFileSync(join(dir, `${VIDEO}.mp4`), Buffer.alloc(4096, 7)); // current 4096
    writeFileSync(join(dir, `prior-1000-${VIDEO}.mp4`), Buffer.alloc(2048, 7)); // prior 2048 <= current
    expect(reclaimSupersededPriors(dir, VIDEO)).toBe(2048);
    expect(readdirSync(dir)).toEqual([`${VIDEO}.mp4`]);
  });

  it('KEEPS a prior the current has NOT caught up to (still a valid fallback)', () => {
    const dir = staging();
    writeFileSync(join(dir, `${VIDEO}.mp4`), Buffer.alloc(1024, 7)); // current 1024
    writeFileSync(join(dir, `prior-1000-${VIDEO}.mp4`), Buffer.alloc(8192, 7)); // prior 8192 > current
    expect(reclaimSupersededPriors(dir, VIDEO)).toBe(0);
    expect(readdirSync(dir).sort()).toEqual([`prior-1000-${VIDEO}.mp4`, `${VIDEO}.mp4`].sort());
  });

  it('no current media yet → every prior kept (nothing has superseded them)', () => {
    const dir = staging();
    writeFileSync(join(dir, `prior-1000-${VIDEO}.mp4`), Buffer.alloc(2048, 7));
    expect(reclaimSupersededPriors(dir, VIDEO)).toBe(0);
    expect(readdirSync(dir)).toEqual([`prior-1000-${VIDEO}.mp4`]);
  });

  it('per-generation: reclaims a superseded gen, keeps the one still ahead of the current', () => {
    const dir = staging();
    writeFileSync(join(dir, `${VIDEO}.mp4`), Buffer.alloc(4096, 7)); // current 4096
    writeFileSync(join(dir, `prior-1000-${VIDEO}.mp4`), Buffer.alloc(2048, 7)); // gen A ≤ current → gone
    writeFileSync(join(dir, `prior-2000-${VIDEO}.mp4`), Buffer.alloc(8192, 7)); // gen B > current → kept
    expect(reclaimSupersededPriors(dir, VIDEO)).toBe(2048);
    expect(readdirSync(dir).sort()).toEqual([`prior-2000-${VIDEO}.mp4`, `${VIDEO}.mp4`].sort());
  });

  it('a superseded generation drops its sidecars too; split-format media summed per generation', () => {
    const dir = staging();
    // current split-format video+audio = 5000 total media bytes
    writeFileSync(join(dir, `${VIDEO}.f299.mp4`), Buffer.alloc(4000, 7));
    writeFileSync(join(dir, `${VIDEO}.f140.mp4`), Buffer.alloc(1000, 7));
    // prior gen 3000: 3000 + 500 = 3500 media (≤ 5000) + a tiny sidecar
    writeFileSync(join(dir, `prior-3000-${VIDEO}.f299.mp4`), Buffer.alloc(3000, 7));
    writeFileSync(join(dir, `prior-3000-${VIDEO}.f140.mp4`), Buffer.alloc(500, 7));
    writeFileSync(join(dir, `prior-3000-${VIDEO}.info.json`), '{}'); // 2 bytes
    expect(reclaimSupersededPriors(dir, VIDEO)).toBe(3500 + 2);
    expect(readdirSync(dir).sort()).toEqual([`${VIDEO}.f140.mp4`, `${VIDEO}.f299.mp4`].sort());
  });

  it('HARD SAFETY: never removes a current (non-prior) file, even one the same size as a prior', () => {
    const dir = staging();
    writeFileSync(join(dir, `${VIDEO}.mp4`), Buffer.alloc(2048, 7)); // current == prior size
    writeFileSync(join(dir, `prior-1000-${VIDEO}.mp4`), Buffer.alloc(2048, 7)); // ≤ current → reclaimed
    reclaimSupersededPriors(dir, VIDEO);
    expect(existsSync(join(dir, `${VIDEO}.mp4`))).toBe(true); // the live recording always survives
  });

  it('is a no-op on a missing/empty staging dir', () => {
    const dir = staging();
    expect(reclaimSupersededPriors(dir, VIDEO)).toBe(0);
    expect(reclaimSupersededPriors(join(dir, 'nope'), VIDEO)).toBe(0);
  });
});

describe('unrelated files are invisible either way', () => {
  it('other videos’ files and foreign prior files never count or resolve', () => {
    const dir = staging();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'othervid.mp4'), Buffer.alloc(4096, 7));
    writeFileSync(join(dir, 'prior-1-othervid.mp4'), Buffer.alloc(4096, 7));
    expect(liveMediaBytes(dir, VIDEO)).toBe(0);
    expect(resolveLiveCaptureArtifacts(dir, VIDEO).mediaPath).toBeNull();
  });
});
