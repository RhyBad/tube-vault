/**
 * Directory-scan result resolution: the download RESULT comes from the staging
 * dir + info.json, never from stdout (PLAN.md risk #1). Ports the spirit of v1
 * `capture_subprocess._find_media` (largest non-sidecar wins) plus v1
 * `resolve_download_result`'s duration/format fields.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { EngineError } from './errors.js';
import { resolveDownloadResult } from './result-resolver.js';

const VIDEO_ID = 'dQw4w9WgXcQ';
const dirs: string[] = [];

async function staging(files: Record<string, string | Buffer>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tv-resolver-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('resolveDownloadResult', () => {
  it('resolves the media + all sidecars from a successful download layout', async () => {
    const info = JSON.stringify({
      id: VIDEO_ID,
      duration: 12.5,
      format_id: '137+140',
      upload_date: '20240131',
      timestamp: 1700000000,
    });
    const dir = await staging({
      [`${VIDEO_ID}.mp4`]: Buffer.alloc(2048, 1),
      [`${VIDEO_ID}.info.json`]: info,
      [`${VIDEO_ID}.webp`]: Buffer.alloc(64, 2),
      [`${VIDEO_ID}.en.vtt`]: 'WEBVTT',
      [`${VIDEO_ID}.ko.srt`]: '1',
    });
    const result = await resolveDownloadResult(dir, VIDEO_ID);
    expect(result.mediaPath).toBe(join(dir, `${VIDEO_ID}.mp4`));
    expect(result.ext).toBe('mp4');
    expect(result.filesizeBytes).toBe(2048);
    expect(result.reportedDurationSeconds).toBe(12.5);
    expect(result.formatId).toBe('137+140');
    // CR-25: publishedAt harvested from the info.json already on disk — exact
    // `timestamp` preferred over the date-only `upload_date`. Zero extra network.
    expect(result.publishedAt).toEqual(new Date(1700000000 * 1000));
    expect(result.infoJsonPath).toBe(join(dir, `${VIDEO_ID}.info.json`));
    expect(result.thumbnailPath).toBe(join(dir, `${VIDEO_ID}.webp`));
    expect(result.subtitlePaths).toEqual([
      join(dir, `${VIDEO_ID}.en.vtt`),
      join(dir, `${VIDEO_ID}.ko.srt`),
    ]);
  });

  it('picks the LARGEST non-sidecar file as the media (v1 _find_media)', async () => {
    const dir = await staging({
      [`${VIDEO_ID}.mp4`]: Buffer.alloc(10, 1),
      [`${VIDEO_ID}.webm`]: Buffer.alloc(5000, 1),
    });
    const result = await resolveDownloadResult(dir, VIDEO_ID);
    expect(result.mediaPath).toBe(join(dir, `${VIDEO_ID}.webm`));
    expect(result.ext).toBe('webm');
  });

  it('never mistakes a sidecar for media (.info.json double-ext, .part, thumbnails, subs)', async () => {
    const dir = await staging({
      [`${VIDEO_ID}.info.json`]: JSON.stringify({ id: VIDEO_ID }),
      [`${VIDEO_ID}.jpg`]: Buffer.alloc(90000, 3), // big thumbnail must not win
      [`${VIDEO_ID}.en.vtt`]: 'WEBVTT',
      [`${VIDEO_ID}.mp4.part`]: Buffer.alloc(80000, 4), // in-progress partial is not media
      [`${VIDEO_ID}.mkv`]: Buffer.alloc(100, 5),
    });
    const result = await resolveDownloadResult(dir, VIDEO_ID);
    expect(result.mediaPath).toBe(join(dir, `${VIDEO_ID}.mkv`));
  });

  it('ignores files belonging to other video ids', async () => {
    const dir = await staging({
      'otherVideo1.mp4': Buffer.alloc(4096, 1),
      [`${VIDEO_ID}.mp4`]: Buffer.alloc(1024, 1),
    });
    const result = await resolveDownloadResult(dir, VIDEO_ID);
    expect(result.mediaPath).toBe(join(dir, `${VIDEO_ID}.mp4`));
  });

  it('throws EngineError when no media file exists (only sidecars / empty dir)', async () => {
    const dir = await staging({ [`${VIDEO_ID}.info.json`]: '{}' });
    await expect(resolveDownloadResult(dir, VIDEO_ID)).rejects.toThrow(EngineError);
    await expect(resolveDownloadResult(dir, VIDEO_ID)).rejects.toThrow(/no media file/i);
  });

  it('tolerates a missing info.json (fields absent, media still resolved)', async () => {
    const dir = await staging({ [`${VIDEO_ID}.mp4`]: Buffer.alloc(1, 1) });
    const result = await resolveDownloadResult(dir, VIDEO_ID);
    expect(result.reportedDurationSeconds).toBeUndefined();
    expect(result.formatId).toBeUndefined();
    expect(result.infoJsonPath).toBeUndefined();
    expect(result.thumbnailPath).toBeUndefined();
    expect(result.subtitlePaths).toEqual([]);
    expect(result.publishedAt).toBeUndefined();
  });

  it('publishedAt falls back to the date-only upload_date when no exact timestamp', async () => {
    const dir = await staging({
      [`${VIDEO_ID}.mp4`]: Buffer.alloc(1, 1),
      [`${VIDEO_ID}.info.json`]: JSON.stringify({ id: VIDEO_ID, upload_date: '20240131' }),
    });
    const result = await resolveDownloadResult(dir, VIDEO_ID);
    // parseUploadDate → midnight UTC of that day (v1 _published_from_date).
    expect(result.publishedAt).toEqual(new Date('2024-01-31T00:00:00.000Z'));
  });

  it('publishedAt is absent when the info.json carries neither timestamp nor upload_date', async () => {
    const dir = await staging({
      [`${VIDEO_ID}.mp4`]: Buffer.alloc(1, 1),
      [`${VIDEO_ID}.info.json`]: JSON.stringify({ id: VIDEO_ID, duration: 10 }),
    });
    const result = await resolveDownloadResult(dir, VIDEO_ID);
    expect(result.publishedAt).toBeUndefined();
  });

  it('tolerates an unparseable/odd info.json (path kept, fields absent, non-finite rejected)', async () => {
    const dir = await staging({
      [`${VIDEO_ID}.mp4`]: Buffer.alloc(1, 1),
      [`${VIDEO_ID}.info.json`]: 'not json {',
    });
    const result = await resolveDownloadResult(dir, VIDEO_ID);
    expect(result.infoJsonPath).toBe(join(dir, `${VIDEO_ID}.info.json`));
    expect(result.reportedDurationSeconds).toBeUndefined();

    const dir2 = await staging({
      [`${VIDEO_ID}.mp4`]: Buffer.alloc(1, 1),
      [`${VIDEO_ID}.info.json`]: JSON.stringify({ duration: 'NaN', format_id: 22 }),
    });
    const result2 = await resolveDownloadResult(dir2, VIDEO_ID);
    expect(result2.reportedDurationSeconds).toBeUndefined();
    expect(result2.formatId).toBeUndefined();
  });
});
