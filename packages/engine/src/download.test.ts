/**
 * Two-pass download orchestration against the committed fake-ytdlp fixture:
 * media pass fail-loud, subtitle pass best-effort-swallowed (v1 429 lesson),
 * result from the directory scan. The engine NEVER wipes staging — keep/wipe
 * is the worker's policy decision. The full scenario matrix (bot wall, kill,
 * unresumable, ...) lives in test/engine.contract.test.ts.
 */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { clearRegisteredSecrets, redact } from './cookies.js';
import { downloadVideo } from './download.js';
import { EngineError } from './errors.js';
import type { ProgressFrame } from './progress.js';
import type { DownloadRequest, EngineConfig } from './ytdlp-args.js';

const FAKE_YTDLP = fileURLToPath(new URL('../test/fixtures/fake-ytdlp.mjs', import.meta.url));

const config: EngineConfig = { ytdlpBin: FAKE_YTDLP, throttle: null };
const dirs: string[] = [];

async function makeRequest(videoId: string): Promise<DownloadRequest> {
  const stagingDir = await mkdtemp(join(tmpdir(), 'tv-download-'));
  dirs.push(stagingDir);
  return {
    url: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
    stagingDir,
    qualityCap: 'UNLIMITED',
    subtitleMode: 'BOTH',
  };
}

afterEach(async () => {
  delete process.env.FAKE_YTDLP_SCENARIO;
  clearRegisteredSecrets();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('downloadVideo', () => {
  it('success: media pass + subtitle pass + dir-scan result', async () => {
    const request = await makeRequest('okvideo0001');
    const frames: ProgressFrame[] = [];
    const outcome = await downloadVideo(config, request, { onProgress: (f) => frames.push(f) });
    expect(outcome.aborted).toBe(false);
    if (outcome.aborted) {
      return; // type narrowing for the assertions below
    }
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames.at(-1)?.phase).toBe('FINISHED');
    expect(outcome.result.ext).toBe('mp4');
    expect(outcome.result.filesizeBytes).toBe(2048);
    expect(outcome.result.reportedDurationSeconds).toBe(12.5);
    // The subtitle pass ran after the media pass and its sidecar was resolved.
    expect(outcome.result.subtitlePaths).toEqual([join(request.stagingDir, 'okvideo0001.en.vtt')]);
  });

  it('media pass failure throws EngineError carrying the stderr tail', async () => {
    process.env.FAKE_YTDLP_SCENARIO = 'http429';
    const request = await makeRequest('failvideo01');
    const err = await downloadVideo(config, request, {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).stderrTail?.join('\n')).toContain('429');
  });

  it('subtitle failure is SWALLOWED (media preserved) and reported via warn', async () => {
    process.env.FAKE_YTDLP_SCENARIO = 'subsfail';
    const request = await makeRequest('subsfail001');
    const warnings: string[] = [];
    const outcome = await downloadVideo(config, request, { warn: (m) => warnings.push(m) });
    expect(outcome.aborted).toBe(false);
    if (outcome.aborted) {
      return;
    }
    expect(outcome.result.filesizeBytes).toBe(2048);
    expect(outcome.result.subtitlePaths).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('subsfail001');
  });

  it('registers the cookie-file secrets at USE time (v1 D7: every --cookies invocation is redaction-covered, however the file was materialized)', async () => {
    const request = await makeRequest('cookieduse1');
    const cookiesDir = await mkdtemp(join(tmpdir(), 'tv-external-cookies-'));
    dirs.push(cookiesDir);
    const cookiesFile = join(cookiesDir, 'cookies.txt');
    // Materialized OUTSIDE writeCookiesTempFile — the registration must still happen.
    await writeFile(
      cookiesFile,
      '.youtube.com\tTRUE\t/\tTRUE\t1799999999\tSIDCC\texternally-materialized-secret\n',
      'utf8',
    );
    const outcome = await downloadVideo(config, { ...request, cookiesFile }, {});
    expect(outcome.aborted).toBe(false);
    expect(redact('oops: externally-materialized-secret')).toBe('oops: ***REDACTED***');
  });

  it('never wipes staging: every artifact is still on disk afterwards', async () => {
    const request = await makeRequest('keepstaging');
    await downloadVideo(config, request, {});
    const names = (await readdir(request.stagingDir)).sort();
    expect(names).toEqual([
      'keepstaging.en.vtt',
      'keepstaging.info.json',
      'keepstaging.mp4',
      'keepstaging.webp',
    ]);
  });
});
