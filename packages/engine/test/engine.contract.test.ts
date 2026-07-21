/**
 * The DUAL-RUN engine contract (v1 `tests/adapters/test_engine_contract.py`
 * pattern): ONE set of invariants asserted against both engines.
 *
 * - fake leg (ALWAYS, main loop + CI): the committed fake-ytdlp fixture must
 *   satisfy the contract — plus the scenario matrix only a fake can produce
 *   (bot wall, 429, kill/stubborn-kill, subtitle failure, unresumable partial).
 * - real leg (`TUBEVAULT_SMOKE=1` only, manual/optional): the SAME success-flow
 *   assertions against real yt-dlp — it DOWNLOADS ONE TINY PUBLIC VIDEO
 *   (jNQXAC9IVRw, "Me at the zoo" — YouTube's first upload, 19s, on the same
 *   never-going-away @jawed channel the enumerate leg lists; yt-dlp's own
 *   former canonical test video BaW_jenozKc was REMOVED from YouTube, observed
 *   2026-07-08) over the network, so it never runs in the deterministic loop.
 *   Requires yt-dlp on PATH.
 */
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { classifyErrorKind, isBotWall } from '@tubevault/core';
import {
  AbortedError,
  downloadVideo,
  engineConfigFromEnv,
  EngineError,
  enumerateArgs,
  flatPlaylistToEntries,
  infoToChannelInfo,
  infoToVideoMetadata,
  metadataArgs,
  probeAvailability,
  probeVodDuration,
  runYtdlp,
  runYtdlpJson,
  type ChannelInfo,
  type ChannelVideoEntry,
  type DownloadRequest,
  type EngineConfig,
  type ProgressFrame,
  type ResolvedDownload,
  type VideoMetadata,
} from '@tubevault/engine';

const FAKE_YTDLP = fileURLToPath(new URL('./fixtures/fake-ytdlp.mjs', import.meta.url));
const SMOKE = process.env.TUBEVAULT_SMOKE === '1';
/** yt-dlp's canonical tiny test video (the real leg downloads it once). */
const SMOKE_VIDEO_ID = 'jNQXAC9IVRw';

const fakeConfig: EngineConfig = { ytdlpBin: FAKE_YTDLP, throttle: null };
const dirs: string[] = [];

async function stagingDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tv-contract-'));
  dirs.push(dir);
  return dir;
}

function makeRequest(dir: string, videoId: string): DownloadRequest {
  return {
    url: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
    stagingDir: dir,
    qualityCap: 'P720',
    subtitleMode: 'BOTH',
  };
}

afterEach(async () => {
  delete process.env.FAKE_YTDLP_SCENARIO;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// --------------------------------------------------------------------------
// The SHARED contract: the same assertions run on the fake AND the real leg.
// --------------------------------------------------------------------------

interface SuccessRun {
  readonly result: ResolvedDownload;
  readonly frames: readonly ProgressFrame[];
}

/** Success flow end-to-end via downloadVideo: the invariant both engines share. */
async function assertSuccessContract(
  config: EngineConfig,
  request: DownloadRequest,
): Promise<SuccessRun> {
  const frames: ProgressFrame[] = [];
  const outcome = await downloadVideo(config, request, { onProgress: (f) => frames.push(f) });
  expect(outcome.aborted).toBe(false);
  if (outcome.aborted) {
    throw new Error('unreachable');
  }
  // Progress plumbing: at least one downloading frame and a finished frame.
  expect(frames.some((f) => f.phase === 'DOWNLOADING')).toBe(true);
  expect(frames.some((f) => f.phase === 'FINISHED')).toBe(true);
  const { result } = outcome;
  // The media file exists on disk with the reported size.
  const size = (await stat(result.mediaPath)).size;
  expect(size).toBe(result.filesizeBytes);
  expect(size).toBeGreaterThan(0);
  expect(result.ext).toBeTruthy();
  expect(result.reportedDurationSeconds).toBeGreaterThan(0);
  return { result, frames };
}

/**
 * Enumerate flow shared by both engines: channel identity + a deduped entry
 * list. Shape/invariant assertions ONLY (no fake-specific counts) so the same
 * function runs against real yt-dlp output under TUBEVAULT_SMOKE=1.
 */
async function assertEnumerateContract(
  config: EngineConfig,
  url: string,
): Promise<{ channel: ChannelInfo; entries: ChannelVideoEntry[] }> {
  const info = await runYtdlpJson(config.ytdlpBin, enumerateArgs(config, url));
  const channel = infoToChannelInfo(info);
  const entries = flatPlaylistToEntries(info);
  expect(channel.channelId).toBeTruthy();
  expect(channel.title).toBeTruthy();
  expect(entries.length).toBeGreaterThan(0);
  const ids = entries.map((e) => e.videoId);
  expect(new Set(ids).size).toBe(ids.length); // deduped across tabs
  for (const entry of entries) {
    expect(entry.videoId).toBeTruthy();
    expect(typeof entry.title).toBe('string');
    if (entry.durationSeconds !== null) {
      expect(entry.durationSeconds).toBeGreaterThan(0);
    }
  }
  return { channel, entries };
}

/** Metadata flow shared by both engines: id round-trip + archivable identity. */
async function assertMetadataContract(
  config: EngineConfig,
  videoId: string,
): Promise<VideoMetadata> {
  const meta = infoToVideoMetadata(
    await runYtdlpJson(
      config.ytdlpBin,
      metadataArgs(config, `https://www.youtube.com/watch?v=${videoId}`),
    ),
  );
  expect(meta.videoId).toBe(videoId);
  expect(meta.title).toBeTruthy();
  expect(meta.channelId).toBeTruthy(); // add-by-url needs a channel to attach to
  expect(meta.durationSeconds).toBeGreaterThan(0);
  return meta;
}

// --------------------------------------------------------------------------
// Fake leg — always runs.
// --------------------------------------------------------------------------

describe('engine contract: fake yt-dlp (always)', () => {
  it('success flow end-to-end: progress frames + resolved result + sidecars', async () => {
    const dir = await stagingDir();
    const { result } = await assertSuccessContract(fakeConfig, makeRequest(dir, 'contractok1'));
    // Fixture-exact facts on top of the shared contract:
    expect(result.ext).toBe('mp4');
    expect(result.filesizeBytes).toBe(2048);
    expect(result.reportedDurationSeconds).toBe(12.5);
    expect(result.formatId).toBe('137+140');
    expect(result.infoJsonPath).toBe(join(dir, 'contractok1.info.json'));
    expect(result.thumbnailPath).toBe(join(dir, 'contractok1.webp'));
    // The subtitle from the separate --skip-download pass was resolved too.
    expect(result.subtitlePaths).toEqual([join(dir, 'contractok1.en.vtt')]);
  });

  it('botwall -> EngineError whose stderr satisfies isBotWall (never a generic failure)', async () => {
    process.env.FAKE_YTDLP_SCENARIO = 'botwall';
    const dir = await stagingDir();
    const err = await downloadVideo(fakeConfig, makeRequest(dir, 'botwalled01'), {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EngineError);
    const joined = ((err as EngineError).stderrTail ?? []).join('\n');
    expect(isBotWall(joined)).toBe(true);
    expect(classifyErrorKind(joined)).toBe('BOT_WALL');
  });

  it('http429 -> EngineError classified RATE_LIMITED via @tubevault/core', async () => {
    process.env.FAKE_YTDLP_SCENARIO = 'http429';
    const dir = await stagingDir();
    const err = await downloadVideo(fakeConfig, makeRequest(dir, 'throttled01'), {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EngineError);
    const joined = ((err as EngineError).stderrTail ?? []).join('\n');
    expect(classifyErrorKind(joined)).toBe('RATE_LIMITED');
  });

  it('subsfail: subtitle 429 is swallowed, warn fires, the media result survives', async () => {
    process.env.FAKE_YTDLP_SCENARIO = 'subsfail';
    const dir = await stagingDir();
    const warnings: string[] = [];
    const outcome = await downloadVideo(fakeConfig, makeRequest(dir, 'subsfail002'), {
      warn: (m) => warnings.push(m),
    });
    expect(outcome.aborted).toBe(false);
    if (outcome.aborted) {
      return;
    }
    expect(outcome.result.filesizeBytes).toBe(2048);
    expect(outcome.result.subtitlePaths).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('media preserved');
  });

  it('KILL: abort mid-download -> aborted:true, child GROUP dead, .part KEPT (engine never wipes)', async () => {
    process.env.FAKE_YTDLP_SCENARIO = 'sleepforever';
    const dir = await stagingDir();
    const controller = new AbortController();
    let pid = 0;
    const outcome = await downloadVideo(fakeConfig, makeRequest(dir, 'killedvid01'), {
      signal: controller.signal,
      onSpawn: (p) => {
        pid = p;
      },
      onProgress: () => controller.abort(), // abort right after the first frame
    });
    expect(outcome).toEqual({ aborted: true });
    expect(pid).toBeGreaterThan(0);
    // The detached child was its own process-group leader; the group must be
    // fully gone (kill(-pid, 0) -> ESRCH).
    expect(() => process.kill(-pid, 0)).toThrow();
    // Pause semantics depend on this: the partial survives the kill.
    expect(await readdir(dir)).toContain('killedvid01.mp4.part');
  }, 15_000);

  it('stubborn KILL: a SIGTERM-ignoring child still dies via the SIGKILL escalation', async () => {
    process.env.FAKE_YTDLP_SCENARIO = 'sleepforever-stubborn';
    const dir = await stagingDir();
    const controller = new AbortController();
    let pid = 0;
    const outcome = await downloadVideo(fakeConfig, makeRequest(dir, 'stubborn001'), {
      signal: controller.signal,
      killGraceMs: 200, // keep the suite fast; production default is 10s
      onSpawn: (p) => {
        pid = p;
      },
      onProgress: () => controller.abort(),
    });
    expect(outcome).toEqual({ aborted: true });
    expect(() => process.kill(-pid, 0)).toThrow();
    expect(await readdir(dir)).toContain('stubborn001.mp4.part');
  }, 15_000);

  it('unresumable: a pre-existing .part makes the fake fail like yt-dlp corrupt-resume (P7 fixture)', async () => {
    process.env.FAKE_YTDLP_SCENARIO = 'unresumable';
    const dir = await stagingDir();
    await writeFile(join(dir, 'unresume001.mp4.part'), Buffer.alloc(64, 1));
    const err = await downloadVideo(fakeConfig, makeRequest(dir, 'unresume001'), {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EngineError);
    expect(((err as EngineError).stderrTail ?? []).join('\n')).toMatch(/cannot resume/i);
    // Without the stale .part the same scenario downloads from scratch fine.
    const dir2 = await stagingDir();
    const outcome = await downloadVideo(fakeConfig, makeRequest(dir2, 'unresume002'), {});
    expect(outcome.aborted).toBe(false);
  });

  describe('-o basename template fidelity (the template<->resolver naming contract)', () => {
    // The fake must HONOR the basename half of the -o template, not just its
    // dirname: resolveDownloadResult scans for the `<videoId>.` prefix, so if
    // outputTemplate() ever regressed (e.g. to %(title)s.%(ext)s) the ALWAYS-ON
    // fake leg has to go red the same way real yt-dlp would break the resolver.
    it('substitutes %(id)s/%(ext)s in the BASENAME for the media pass artifacts', async () => {
      const dir = await stagingDir();
      const res = await runYtdlp(FAKE_YTDLP, [
        '-o',
        join(dir, 'custom-%(id)s.%(ext)s'),
        'https://www.youtube.com/watch?v=tmplvideo01',
      ]);
      expect(res.exitCode).toBe(0);
      expect((await readdir(dir)).sort()).toEqual([
        'custom-tmplvideo01.info.json',
        'custom-tmplvideo01.mp4',
        'custom-tmplvideo01.webp',
      ]);
    });

    it('the SUBTITLE pass follows the basename template too', async () => {
      const dir = await stagingDir();
      const res = await runYtdlp(FAKE_YTDLP, [
        '--skip-download',
        '-o',
        join(dir, 'custom-%(id)s.%(ext)s'),
        'https://www.youtube.com/watch?v=tmplvideo02',
      ]);
      expect(res.exitCode).toBe(0);
      expect(await readdir(dir)).toEqual(['custom-tmplvideo02.en.vtt']);
    });

    it('FAILS LOUDLY on template fields it cannot substitute (writes nothing)', async () => {
      const dir = await stagingDir();
      const res = await runYtdlp(FAKE_YTDLP, [
        '-o',
        join(dir, '%(title)s.%(ext)s'),
        'https://www.youtube.com/watch?v=tmplvideo03',
      ]);
      expect(res.exitCode).not.toBe(0);
      expect(res.stderrTail.join('\n')).toMatch(/unsupported -o template field/);
      expect(res.stderrTail.join('\n')).toContain('%(title)s');
      expect(await readdir(dir)).toEqual([]);
    });
  });

  describe('enumerate/metadata mapping contract (P5)', () => {
    const channelUrl = 'https://www.youtube.com/@fakechannel/videos';

    it('enumerate: shared contract + fixture-exact channel identity and NESTED-tab entries', async () => {
      const { channel, entries } = await assertEnumerateContract(fakeConfig, channelUrl);
      // Fixture-exact facts on top of the shared contract: the channel root
      // nests one playlist per tab (real yt-dlp shape) and the mapper flattens it.
      expect(channel).toEqual({
        channelId: 'UCfakechannel000000000000',
        title: 'Fake Channel', // channel name preferred over 'Fake Channel - Videos'
        handle: '@fakechannel',
        url: 'https://www.youtube.com/channel/UCfakechannel000000000000',
      });
      expect(entries.map((e) => e.videoId)).toEqual(['fakevid0001', 'fakevid0002', 'fakevid0003']);
      expect(entries.map((e) => e.liveStatus)).toEqual(['not_live', 'not_live', 'was_live']);
      // Real flat entries usually lack upload_date; the fixture mirrors that.
      expect(entries.every((e) => e.uploadDate === null)).toBe(true);
      expect(entries.every((e) => (e.durationSeconds ?? 0) > 0)).toBe(true);
    });

    it('metadata: shared contract + fixture-exact add-url fields (channel title/url/timestamp)', async () => {
      const meta = await assertMetadataContract(fakeConfig, 'metavideo01');
      expect(meta.channelId).toBe('UCfakechannel000000000000');
      expect(meta.channelTitle).toBe('Fake Channel');
      expect(meta.timestamp).toEqual(new Date(1700000000 * 1000));
      // Real metadata carries BOTH — consumers prefer the exact timestamp.
      expect(meta.uploadDate).toEqual(new Date(Date.UTC(2024, 0, 31)));
      expect(meta.webpageUrl).toBe('https://www.youtube.com/watch?v=metavideo01');
      expect(meta.availability).toBe('public');
      expect(meta.liveStatus).toBe('not_live');
      expect(meta.description).toBe('Fake description for metavideo01.'); // CR-14
    });

    it("metadata: a 'live…' video id reports was_live (content-type classification fodder)", async () => {
      const meta = await assertMetadataContract(fakeConfig, 'livevid0001');
      expect(meta.liveStatus).toBe('was_live');
    });

    it('botwall during enumerate → EngineError classified BOT_WALL (same as the download branch)', async () => {
      process.env.FAKE_YTDLP_SCENARIO = 'botwall';
      const err = await runYtdlpJson(FAKE_YTDLP, enumerateArgs(fakeConfig, channelUrl)).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(EngineError);
      expect(classifyErrorKind(((err as EngineError).stderrTail ?? []).join('\n'))).toBe(
        'BOT_WALL',
      );
    });

    it('http429 during enumerate → EngineError classified RATE_LIMITED', async () => {
      process.env.FAKE_YTDLP_SCENARIO = 'http429';
      const err = await runYtdlpJson(FAKE_YTDLP, enumerateArgs(fakeConfig, channelUrl)).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(EngineError);
      expect(classifyErrorKind(((err as EngineError).stderrTail ?? []).join('\n'))).toBe(
        'RATE_LIMITED',
      );
    });

    it('botwall during metadata → EngineError classified BOT_WALL', async () => {
      process.env.FAKE_YTDLP_SCENARIO = 'botwall';
      const err = await runYtdlpJson(
        FAKE_YTDLP,
        metadataArgs(fakeConfig, 'https://www.youtube.com/watch?v=metavideo01'),
      ).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(EngineError);
      expect(classifyErrorKind(((err as EngineError).stderrTail ?? []).join('\n'))).toBe(
        'BOT_WALL',
      );
    });

    it('CANCEL during enumerate: sleepforever hangs, abort → AbortedError + dead child group', async () => {
      process.env.FAKE_YTDLP_SCENARIO = 'sleepforever';
      const controller = new AbortController();
      let pid = 0;
      setTimeout(() => controller.abort(), 300);
      const err = await runYtdlpJson(FAKE_YTDLP, enumerateArgs(fakeConfig, channelUrl), {
        signal: controller.signal,
        onSpawn: (p) => {
          pid = p;
        },
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AbortedError);
      expect(err).not.toBeInstanceOf(EngineError); // cancel is NOT a failure
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(-pid, 0)).toThrow(); // group fully gone
    }, 15_000);
  });
});

// --------------------------------------------------------------------------
// Real leg — the SAME shared assertions, behind TUBEVAULT_SMOKE=1.
// Downloads ONE tiny public video (network + yt-dlp on PATH required).
// --------------------------------------------------------------------------

describe.skipIf(!SMOKE)('engine contract: REAL yt-dlp (TUBEVAULT_SMOKE=1)', () => {
  it('success flow end-to-end against the canonical tiny test video', async () => {
    // The real leg honors ALL the env knobs the apps use — proxy, player
    // client and POT provider can rescue a bot-flagged host, and the throttle
    // stays gently ON by default (engineConfigFromEnv is the apps' entrypoint).
    const config: EngineConfig = engineConfigFromEnv(process.env);
    const dir = await stagingDir();
    const { result } = await assertSuccessContract(config, makeRequest(dir, SMOKE_VIDEO_ID));
    expect(result.infoJsonPath).toBeDefined();
  }, 600_000);

  it('enumerate: the SAME shared contract against a tiny stable real channel (@jawed)', async () => {
    // @jawed (YouTube's co-founder, "Me at the zoo") — the canonical tiny,
    // never-going-away channel: one page of flat entries, cheap to list.
    const config: EngineConfig = engineConfigFromEnv(process.env);
    await assertEnumerateContract(config, 'https://www.youtube.com/@jawed/videos');
  }, 600_000);

  it('metadata: the SAME shared contract against the canonical tiny test video', async () => {
    const config: EngineConfig = engineConfigFromEnv(process.env);
    await assertMetadataContract(config, SMOKE_VIDEO_ID);
  }, 600_000);

  it('probeAvailability: a live public video maps to AVAILABLE', async () => {
    const config: EngineConfig = engineConfigFromEnv(process.env);
    await expect(
      probeAvailability(config, `https://www.youtube.com/watch?v=${SMOKE_VIDEO_ID}`),
    ).resolves.toBe('AVAILABLE');
  }, 600_000);
});

// --------------------------------------------------------------------------
// CR-09 probeAvailability — metadata-only availability probe (fake leg).
// The classification is @tubevault/core's; here we pin that the probe threads a
// success `availability` and each failure's stderr tail through to the right
// SourceState, and never downloads media.
// --------------------------------------------------------------------------

describe('probeAvailability (CR-09, fake leg)', () => {
  const url = 'https://www.youtube.com/watch?v=probevid001';

  it('is a metadata-only invocation: --dump-single-json --no-download, no media', () => {
    const args = metadataArgs(fakeConfig, url);
    expect(args).toContain('--dump-single-json');
    expect(args).toContain('--no-download');
  });

  it('maps a healthy public video to AVAILABLE', async () => {
    // default 'success' scenario emits availability: 'public'
    await expect(probeAvailability(fakeConfig, url)).resolves.toBe('AVAILABLE');
  });

  it('maps a deletion stderr to DELETED (a definite-gone signature)', async () => {
    process.env.FAKE_YTDLP_SCENARIO = 'gone';
    await expect(probeAvailability(fakeConfig, url)).resolves.toBe('DELETED');
  });

  it('maps a members-only stderr to MEMBERS_ONLY (inconclusive for the gate)', async () => {
    process.env.FAKE_YTDLP_SCENARIO = 'members';
    await expect(probeAvailability(fakeConfig, url)).resolves.toBe('MEMBERS_ONLY');
  });

  it('maps an HTTP 429 stderr to RATE_LIMITED — NEVER a false DELETED', async () => {
    process.env.FAKE_YTDLP_SCENARIO = 'http429';
    await expect(probeAvailability(fakeConfig, url)).resolves.toBe('RATE_LIMITED');
  });
});

// --------------------------------------------------------------------------
// CR-20 probeVodDuration — the live-completeness re-check probe (fake leg).
// Pins that it reads {liveStatus, durationSeconds, availability} from a cookie'd
// metadata call, that a members-only VOD is measurable, and that an errored
// probe is a soft "unmeasurable" (never throws) so the sweep can re-check.
// --------------------------------------------------------------------------

describe('probeVodDuration (CR-20, fake leg)', () => {
  const anyVod = 'https://www.youtube.com/watch?v=probevod001';
  // A 'live'-prefixed id maps to live_status was_live in the default scenario.
  const publicDoneVod = 'https://www.youtube.com/watch?v=livevod0001';

  it('is a metadata-only invocation that threads session cookies (members-only measurable)', () => {
    const args = metadataArgs(fakeConfig, anyVod, '/tmp/tv-cookies/cookies.txt');
    expect(args).toContain('--dump-single-json');
    expect(args).toContain('--no-download');
    expect(args[args.indexOf('--cookies') + 1]).toBe('/tmp/tv-cookies/cookies.txt');
  });

  it('a completed public live -> was_live + a real duration + publishedAt (measurable)', async () => {
    await expect(probeVodDuration(fakeConfig, publicDoneVod)).resolves.toEqual({
      liveStatus: 'was_live',
      durationSeconds: 12.5,
      availability: 'public',
      // CR-25: the VOD metadata already carries the real publish time — the
      // completeness probe surfaces it so the finalize/recheck path can backfill
      // publishedAt (exact `timestamp` preferred over date-only `upload_date`).
      publishedAt: new Date(1700000000 * 1000),
    });
  });

  it('a still-processing VOD -> post_live + NO duration + NO publishedAt (defer & re-check)', async () => {
    process.env.FAKE_YTDLP_SCENARIO = 'vod-processing';
    await expect(probeVodDuration(fakeConfig, anyVod)).resolves.toEqual({
      liveStatus: 'post_live',
      durationSeconds: null,
      availability: 'public',
      // A still-processing VOD carries no publish metadata yet → null. The
      // recheck sweep backfills it once the VOD publishes (never nulls-out).
      publishedAt: null,
    });
  });

  it('a completed MEMBERS-ONLY live -> was_live + duration + publishedAt (cookies make it measurable)', async () => {
    process.env.FAKE_YTDLP_SCENARIO = 'vod-members-done';
    await expect(probeVodDuration(fakeConfig, anyVod)).resolves.toEqual({
      liveStatus: 'was_live',
      durationSeconds: 3600,
      availability: 'subscriber_only',
      // CR-25: a members VOD is as measurable as a public one, publishedAt too.
      publishedAt: new Date(1700000000 * 1000),
    });
  });

  it('an errored probe (429/gone/network) -> unmeasurable, never throws (the sweep re-checks)', async () => {
    process.env.FAKE_YTDLP_SCENARIO = 'http429';
    await expect(probeVodDuration(fakeConfig, anyVod)).resolves.toEqual({
      liveStatus: 'unknown',
      durationSeconds: null,
      availability: null,
      publishedAt: null,
    });
  });
});
