/**
 * Pure argv builders (no I/O), ported from v1 `adapters/engine_ytdlp.py`
 * (`_base_opts`/`_media_opts`/`_subtitle_pass_opts` mapped to CLI spellings) and
 * v1 `config.py` (`YtdlpThrottle` — EXACT env names, gentle DEFAULTS-ON).
 *
 * The full-argv assertions ARE the snapshots: any drift in flag set/order is a
 * red test, which is the bot-wall regression guard PLAN.md demands.
 */
import { describe, expect, it } from 'vitest';

import {
  baseArgs,
  channelLiveUrl,
  DEFAULT_THROTTLE,
  downloadArgs,
  engineConfigFromEnv,
  enumerateArgs,
  liveCaptureArgs,
  liveProbeArgs,
  metadataArgs,
  subtitleArgs,
  throttleConfigFromEnv,
  type DownloadRequest,
  type EngineConfig,
  type LiveCaptureRequest,
} from './ytdlp-args.js';

const bareConfig: EngineConfig = { ytdlpBin: 'yt-dlp', throttle: null };

const fullConfig: EngineConfig = {
  ytdlpBin: 'yt-dlp',
  proxy: 'socks5://proxy.lan:1080',
  playerClient: 'web_creator',
  potProviderUrl: 'http://bgutil:4416',
  throttle: DEFAULT_THROTTLE,
};

const request: DownloadRequest = {
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  videoId: 'dQw4w9WgXcQ',
  stagingDir: '/data/media/UC123/dQw4w9WgXcQ/.incoming',
  qualityCap: 'P1080',
  subtitleMode: 'BOTH',
  cookiesFile: '/tmp/tv-cookies/cookies.txt',
};

describe('throttleConfigFromEnv (v1 YtdlpThrottle port)', () => {
  it('empty env yields the gentle DEFAULTS-ON throttle (bot-wall lever)', () => {
    expect(throttleConfigFromEnv({})).toEqual({
      sleepRequests: 1.0,
      sleepInterval: 2.0,
      maxSleepInterval: 5.0,
      limitRateBytes: null,
      concurrentFragments: null,
      retries: 3,
      fragmentRetries: 5,
    });
  });

  it('honors the EXACT v1 env names', () => {
    expect(
      throttleConfigFromEnv({
        TUBEVAULT_YTDLP_SLEEP_REQUESTS: '2.5',
        TUBEVAULT_YTDLP_SLEEP_INTERVAL: '3',
        TUBEVAULT_YTDLP_MAX_SLEEP_INTERVAL: '8',
        TUBEVAULT_YTDLP_LIMIT_RATE: '2M',
        TUBEVAULT_YTDLP_CONCURRENT_FRAGMENTS: '2',
        TUBEVAULT_YTDLP_RETRIES: '1',
        TUBEVAULT_YTDLP_FRAGMENT_RETRIES: '2',
      }),
    ).toEqual({
      sleepRequests: 2.5,
      sleepInterval: 3,
      maxSleepInterval: 8,
      limitRateBytes: 2 * 1024 * 1024,
      concurrentFragments: 2,
      retries: 1,
      fragmentRetries: 2,
    });
  });

  it("parses human rates like v1 _parse_rate ('500K', bare bytes)", () => {
    expect(throttleConfigFromEnv({ TUBEVAULT_YTDLP_LIMIT_RATE: '500K' }).limitRateBytes).toBe(
      512000,
    );
    expect(throttleConfigFromEnv({ TUBEVAULT_YTDLP_LIMIT_RATE: '1048576' }).limitRateBytes).toBe(
      1048576,
    );
  });

  it('explicit 0 opts a sleep OUT (v1: set to 0 to disable a knob)', () => {
    const cfg = throttleConfigFromEnv({ TUBEVAULT_YTDLP_SLEEP_REQUESTS: '0' });
    expect(cfg.sleepRequests).toBe(0);
  });

  it('blank/whitespace values fall back to the defaults (v1 empty-string semantics)', () => {
    expect(throttleConfigFromEnv({ TUBEVAULT_YTDLP_RETRIES: '  ' }).retries).toBe(3);
  });

  it('rejects non-numeric, negative, and max<min values (v1 validation)', () => {
    expect(() => throttleConfigFromEnv({ TUBEVAULT_YTDLP_SLEEP_REQUESTS: 'abc' })).toThrow(
      /must be a number/,
    );
    expect(() => throttleConfigFromEnv({ TUBEVAULT_YTDLP_RETRIES: '1.5' })).toThrow(
      /must be an integer/,
    );
    expect(() => throttleConfigFromEnv({ TUBEVAULT_YTDLP_LIMIT_RATE: 'fast' })).toThrow(
      /byte rate/,
    );
    expect(() => throttleConfigFromEnv({ TUBEVAULT_YTDLP_SLEEP_INTERVAL: '-1' })).toThrow(
      /non-negative/,
    );
    expect(() =>
      throttleConfigFromEnv({
        TUBEVAULT_YTDLP_SLEEP_INTERVAL: '9',
        TUBEVAULT_YTDLP_MAX_SLEEP_INTERVAL: '4',
      }),
    ).toThrow(/max_sleep_interval|maxSleepInterval/i);
  });
});

describe('engineConfigFromEnv', () => {
  it('reads the v1 TUBEVAULT_YTDLP_* names and defaults throttle ON', () => {
    const cfg = engineConfigFromEnv({
      TUBEVAULT_YTDLP_PROXY: 'http://egress:3128',
      TUBEVAULT_YTDLP_PLAYER_CLIENT: 'android',
      TUBEVAULT_YTDLP_POT_PROVIDER_URL: 'http://bgutil:4416',
    });
    expect(cfg.ytdlpBin).toBe('yt-dlp');
    expect(cfg.proxy).toBe('http://egress:3128');
    expect(cfg.playerClient).toBe('android');
    expect(cfg.potProviderUrl).toBe('http://bgutil:4416');
    expect(cfg.throttle).toEqual(DEFAULT_THROTTLE);
  });

  it('empty env: no proxy/client/pot, throttle still ON', () => {
    const cfg = engineConfigFromEnv({});
    expect(cfg.proxy).toBeUndefined();
    expect(cfg.playerClient).toBeUndefined();
    expect(cfg.potProviderUrl).toBeUndefined();
    expect(cfg.throttle).toEqual(DEFAULT_THROTTLE);
  });

  it("TUBEVAULT_YTDLP_BIN unset/blank → the PATH default 'yt-dlp'", () => {
    expect(engineConfigFromEnv({}).ytdlpBin).toBe('yt-dlp');
    expect(engineConfigFromEnv({ TUBEVAULT_YTDLP_BIN: '   ' }).ytdlpBin).toBe('yt-dlp');
  });

  it('TUBEVAULT_YTDLP_BIN overrides the binary (tests point it at the fake fixture)', () => {
    expect(engineConfigFromEnv({ TUBEVAULT_YTDLP_BIN: '/fixtures/fake-ytdlp.mjs' }).ytdlpBin).toBe(
      '/fixtures/fake-ytdlp.mjs',
    );
  });

  it("TUBEVAULT_FFPROBE_BIN unset/blank → the PATH default 'ffprobe' (P6 verify)", () => {
    expect(engineConfigFromEnv({}).ffprobeBin).toBe('ffprobe');
    expect(engineConfigFromEnv({ TUBEVAULT_FFPROBE_BIN: '  ' }).ffprobeBin).toBe('ffprobe');
  });

  it('TUBEVAULT_FFPROBE_BIN overrides the binary (tests point it at fake-ffprobe)', () => {
    expect(
      engineConfigFromEnv({ TUBEVAULT_FFPROBE_BIN: '/fixtures/fake-ffprobe.mjs' }).ffprobeBin,
    ).toBe('/fixtures/fake-ffprobe.mjs');
  });
});

describe('baseArgs', () => {
  it('full config snapshot: socket-timeout, proxy, both extractor-args, cookies, throttle', () => {
    expect(baseArgs(fullConfig, '/tmp/c.txt')).toEqual([
      '--socket-timeout',
      '30',
      '--no-warnings',
      '--proxy',
      'socks5://proxy.lan:1080',
      '--extractor-args',
      'youtube:player_client=web_creator',
      '--extractor-args',
      'youtubepot-bgutilhttp:base_url=http://bgutil:4416',
      '--cookies',
      '/tmp/c.txt',
      '--sleep-requests',
      '1',
      '--sleep-interval',
      '2',
      '--max-sleep-interval',
      '5',
      '--retries',
      '3',
      '--fragment-retries',
      '5',
    ]);
  });

  it('bare config (throttle null, nothing set) emits only the timeout + no-warnings', () => {
    expect(baseArgs(bareConfig)).toEqual(['--socket-timeout', '30', '--no-warnings']);
  });

  it("emits --no-warnings on EVERY invocation (v1 _base_opts no_warnings: WARNING lines must not pollute the stderr classification tail) — but NEVER --quiet (it would reroute the progress template's screen output)", () => {
    const argvs = [
      baseArgs(fullConfig, '/tmp/c.txt'),
      downloadArgs(fullConfig, request),
      subtitleArgs(fullConfig, request) ?? [],
      enumerateArgs(fullConfig, 'https://youtube.com/@c'),
      metadataArgs(fullConfig, 'https://youtube.com/watch?v=x'),
    ];
    for (const argv of argvs) {
      expect(argv.filter((a) => a === '--no-warnings')).toHaveLength(1);
      expect(argv).not.toContain('--quiet');
      expect(argv).not.toContain('-q');
    }
  });

  it('only SET throttle knobs emit flags (None/null = leave yt-dlp default)', () => {
    const cfg: EngineConfig = {
      ytdlpBin: 'yt-dlp',
      throttle: {
        sleepRequests: null,
        sleepInterval: null,
        maxSleepInterval: null,
        limitRateBytes: 512000,
        concurrentFragments: 4,
        retries: null,
        fragmentRetries: null,
      },
    };
    expect(baseArgs(cfg)).toEqual([
      '--socket-timeout',
      '30',
      '--no-warnings',
      '--limit-rate',
      '512000',
      '--concurrent-fragments',
      '4',
    ]);
  });
});

describe('downloadArgs (the MEDIA pass)', () => {
  it('full argv snapshot with the default-from-env config', () => {
    const cfg = engineConfigFromEnv({});
    expect(downloadArgs(cfg, request)).toEqual([
      '--socket-timeout',
      '30',
      '--no-warnings',
      '--cookies',
      '/tmp/tv-cookies/cookies.txt',
      '--sleep-requests',
      '1',
      '--sleep-interval',
      '2',
      '--max-sleep-interval',
      '5',
      '--retries',
      '3',
      '--fragment-retries',
      '5',
      '-f',
      'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
      '-o',
      '/data/media/UC123/dQw4w9WgXcQ/.incoming/%(id)s.%(ext)s',
      '--continue',
      '--write-info-json',
      '--write-thumbnail',
      '--no-playlist',
      '--newline',
      '--progress-template',
      'download:TVPROG1 %(progress)j',
      '--progress-delta',
      '0.5',
      '--color',
      'no_color',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    ]);
  });

  it('REGRESSION GUARD: the default config emits the throttle flags (bot-wall protection)', () => {
    // If this ever fails, the gentle-throttle-by-default lever regressed — the
    // single hardest-won protection against YouTube's bot wall. Do NOT weaken.
    const argv = downloadArgs(engineConfigFromEnv({}), request);
    expect(argv).toContain('--sleep-requests');
    expect(argv).toContain('--sleep-interval');
    expect(argv).toContain('--max-sleep-interval');
    expect(argv).toContain('--retries');
    expect(argv).toContain('--fragment-retries');
    expect(argv[argv.indexOf('--sleep-requests') + 1]).toBe('1');
    expect(argv[argv.indexOf('--sleep-interval') + 1]).toBe('2');
    expect(argv[argv.indexOf('--max-sleep-interval') + 1]).toBe('5');
    expect(argv[argv.indexOf('--retries') + 1]).toBe('3');
    expect(argv[argv.indexOf('--fragment-retries') + 1]).toBe('5');
    // Unset knobs must stay at yt-dlp's own defaults.
    expect(argv).not.toContain('--limit-rate');
    expect(argv).not.toContain('--concurrent-fragments');
  });

  it('REGRESSION GUARD: --continue (-c) is EXPLICIT on every media pass — resumes .part AND .ytdl fragment state (P7 pause/resume)', () => {
    // yt-dlp resumes .part files by default, but the explicit -c/--continue
    // ALSO resumes fragment state (the .ytdl sidecar) — PLAN.md verified fact.
    // The P7 pause→resume flow depends on it; do NOT drop this flag.
    const argv = downloadArgs(engineConfigFromEnv({}), request);
    expect(argv.filter((a) => a === '--continue')).toHaveLength(1);
    expect(argv).not.toContain('--no-continue');
  });

  it('NEVER contains subtitle flags for any subtitle mode (v1 429 lesson: media pass is subtitle-free)', () => {
    for (const mode of ['AUTO', 'MANUAL', 'BOTH'] as const) {
      const argv = downloadArgs(fullConfig, { ...request, subtitleMode: mode });
      expect(argv).not.toContain('--write-subs');
      expect(argv).not.toContain('--write-auto-subs');
      expect(argv).not.toContain('--sub-langs');
      expect(argv).not.toContain('--skip-download');
    }
  });

  it('UNLIMITED cap uses the best-available selector', () => {
    const argv = downloadArgs(bareConfig, { ...request, qualityCap: 'UNLIMITED' });
    expect(argv[argv.indexOf('-f') + 1]).toBe('bestvideo*+bestaudio/best');
  });

  it('sidecar toggles (v1 write_thumbnail/write_info_json parity): default ON, individually opt-out', () => {
    const both = downloadArgs(bareConfig, request);
    expect(both).toContain('--write-info-json');
    expect(both).toContain('--write-thumbnail');
    const noInfo = downloadArgs(bareConfig, { ...request, writeInfoJson: false });
    expect(noInfo).not.toContain('--write-info-json');
    expect(noInfo).toContain('--write-thumbnail');
    const noThumb = downloadArgs(bareConfig, { ...request, writeThumbnail: false });
    expect(noThumb).toContain('--write-info-json');
    expect(noThumb).not.toContain('--write-thumbnail');
  });

  it('omits --cookies when the request has no cookies file', () => {
    const noCookies: DownloadRequest = {
      url: request.url,
      videoId: request.videoId,
      stagingDir: request.stagingDir,
      qualityCap: request.qualityCap,
      subtitleMode: request.subtitleMode,
    };
    expect(downloadArgs(bareConfig, noCookies)).not.toContain('--cookies');
  });
});

describe('subtitleArgs (the best-effort SUBTITLE pass)', () => {
  it('BOTH: full argv snapshot — skip-download + both sub flags + all langs', () => {
    expect(subtitleArgs(bareConfig, request)).toEqual([
      '--socket-timeout',
      '30',
      '--no-warnings',
      '--cookies',
      '/tmp/tv-cookies/cookies.txt',
      '--skip-download',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs',
      'all',
      '-o',
      '/data/media/UC123/dQw4w9WgXcQ/.incoming/%(id)s.%(ext)s',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    ]);
  });

  it('MANUAL: only --write-subs; AUTO: only --write-auto-subs', () => {
    const manual = subtitleArgs(bareConfig, { ...request, subtitleMode: 'MANUAL' });
    expect(manual).toContain('--write-subs');
    expect(manual).not.toContain('--write-auto-subs');
    const auto = subtitleArgs(bareConfig, { ...request, subtitleMode: 'AUTO' });
    expect(auto).toContain('--write-auto-subs');
    expect(auto).not.toContain('--write-subs');
  });

  it('returns null when the mode requests nothing (defensive: future NONE mode)', () => {
    // No current SubtitleMode requests nothing; guard the v1 branch anyway.
    const none = subtitleArgs(bareConfig, {
      ...request,
      subtitleMode: 'NONE' as unknown as DownloadRequest['subtitleMode'],
    });
    expect(none).toBeNull();
  });
});

describe('enumerateArgs / metadataArgs', () => {
  it('enumerate: flat channel listing argv', () => {
    expect(enumerateArgs(bareConfig, 'https://www.youtube.com/@chan/videos')).toEqual([
      '--socket-timeout',
      '30',
      '--no-warnings',
      '--flat-playlist',
      '--dump-single-json',
      'https://www.youtube.com/@chan/videos',
    ]);
  });

  it('metadata: single-video dump argv', () => {
    expect(metadataArgs(bareConfig, 'https://www.youtube.com/watch?v=abc12345678')).toEqual([
      '--socket-timeout',
      '30',
      '--no-warnings',
      '--dump-single-json',
      '--no-download',
      'https://www.youtube.com/watch?v=abc12345678',
    ]);
  });

  it('both accept an optional cookies file through baseArgs', () => {
    expect(enumerateArgs(fullConfig, 'https://youtube.com/@c', '/tmp/c.txt')).toContain(
      '--cookies',
    );
    expect(metadataArgs(fullConfig, 'https://youtube.com/watch?v=x', '/tmp/c.txt')).toContain(
      '--cookies',
    );
  });
});

// ---------------------------------------------------------------------------
// Live probe + capture (P10). liveProbeArgs = the metadata dump of the
// channel's /live URL (v1 probe_live resolved it with download=False);
// liveCaptureArgs = v1 build_capture_argv ported EXACTLY, with the v2 TVPROG1
// telemetry addition replacing v1's --no-progress.
// ---------------------------------------------------------------------------

const CHANNEL_ID = 'UClivechan00000000000000';

const captureRequest: LiveCaptureRequest = {
  url: 'https://www.youtube.com/watch?v=livebcast01',
  videoId: 'livebcast01',
  stagingDir: '/data/media/UC123/livebcast01 - t/.incoming.live',
  qualityCap: 'UNLIMITED',
  cookiesFile: '/tmp/tv-cookies/cookies.txt',
};

describe('channelLiveUrl (v1 channel_live_url)', () => {
  it('keys on the immutable channel id (a handle can change)', () => {
    expect(channelLiveUrl(CHANNEL_ID)).toBe(`https://www.youtube.com/channel/${CHANNEL_ID}/live`);
  });
});

describe('liveProbeArgs (the /live resolution probe)', () => {
  it('is the metadata dump of the /live URL (v1 _extract with download=False)', () => {
    expect(liveProbeArgs(bareConfig, CHANNEL_ID)).toEqual([
      '--socket-timeout',
      '30',
      '--no-warnings',
      '--dump-single-json',
      '--no-download',
      `https://www.youtube.com/channel/${CHANNEL_ID}/live`,
    ]);
  });

  it('threads cookies through baseArgs (members-only lives are detectable, F2)', () => {
    const argv = liveProbeArgs(fullConfig, CHANNEL_ID, '/tmp/c.txt');
    expect(argv[argv.indexOf('--cookies') + 1]).toBe('/tmp/c.txt');
  });

  it('REGRESSION GUARD: the default config keeps the throttle flags on probes', () => {
    const argv = liveProbeArgs(engineConfigFromEnv({}), CHANNEL_ID);
    expect(argv).toContain('--sleep-requests');
    expect(argv).toContain('--retries');
  });
});

describe('liveCaptureArgs (v1 build_capture_argv port)', () => {
  it('full argv snapshot with the default-from-env config — NO throttle/retry knobs (v1 capture_subprocess parity)', () => {
    expect(liveCaptureArgs(engineConfigFromEnv({}), captureRequest)).toEqual([
      '--socket-timeout',
      '30',
      '--no-warnings',
      '--cookies',
      '/tmp/tv-cookies/cookies.txt',
      '-f',
      'bestvideo*+bestaudio/best',
      '-o',
      '/data/media/UC123/livebcast01 - t/.incoming.live/%(id)s.%(ext)s',
      '--live-from-start',
      '--no-playlist',
      '--no-part',
      '--newline',
      '--progress-template',
      'download:TVPROG1 %(progress)j',
      '--progress-delta',
      '0.5',
      '--color',
      'no_color',
      'https://www.youtube.com/watch?v=livebcast01',
    ]);
  });

  it('REGRESSION GUARD: --live-from-start (never miss the opening, F3) and --no-part (a kill leaves a playable partial, D10)', () => {
    const argv = liveCaptureArgs(bareConfig, captureRequest);
    expect(argv).toContain('--live-from-start');
    expect(argv).toContain('--no-part');
    expect(argv).not.toContain('--no-progress'); // v2 deviation: TVPROG1 telemetry instead
    expect(argv).not.toContain('--continue'); // --no-part records straight to the final name
  });

  it('REGRESSION GUARD: NEVER carries throttle/retry knobs, even with the throttle configured (v1 capture_subprocess passed NONE — yt-dlp’s own 10/10 retries are the loss-sensitive right call for a live recording)', () => {
    const argv = liveCaptureArgs(engineConfigFromEnv({}), captureRequest);
    for (const knob of [
      '--sleep-requests',
      '--sleep-interval',
      '--max-sleep-interval',
      '--limit-rate',
      '--concurrent-fragments',
      '--retries',
      '--fragment-retries',
    ]) {
      expect(argv, `${knob} must not reach a live capture`).not.toContain(knob);
    }
  });

  it('carries the bot-wall levers through baseArgs (proxy, player_client, pot)', () => {
    const argv = liveCaptureArgs(fullConfig, captureRequest);
    expect(argv[argv.indexOf('--proxy') + 1]).toBe('socks5://proxy.lan:1080');
    expect(argv).toContain('youtube:player_client=web_creator');
    expect(argv).toContain('youtubepot-bgutilhttp:base_url=http://bgutil:4416');
  });

  it('omits --cookies without a session; policy cap flows into -f', () => {
    const argv = liveCaptureArgs(bareConfig, {
      url: captureRequest.url,
      videoId: captureRequest.videoId,
      stagingDir: captureRequest.stagingDir,
      qualityCap: 'P1080',
    });
    expect(argv).not.toContain('--cookies');
    expect(argv[argv.indexOf('-f') + 1]).toBe(
      'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
    );
  });
});
