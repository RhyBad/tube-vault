/**
 * PURE yt-dlp argv builders — no I/O, fully offline-testable.
 *
 * Ported from v1 `adapters/engine_ytdlp.py` (`_base_opts` / `_media_opts` /
 * `_subtitle_pass_opts`, Python-API opts mapped to their CLI spellings) and v1
 * `config.py` `YtdlpThrottle` (EXACT env names, gentle DEFAULTS-ON values,
 * null = leave that knob at yt-dlp's own default).
 *
 * Two hard-won invariants live here (see PLAN.md "Bot-wall levers"):
 * 1. The throttle is ON by default — an empty env still paces yt-dlp gently.
 * 2. The MEDIA pass carries NO subtitle flags: a subtitle-endpoint 429 must
 *    never take down the media download (the two-pass v1 429 lesson).
 */
import { join } from 'node:path';

import {
  formatSelector,
  subtitleDecision,
  type QualityCap,
  type SubtitleMode,
} from '@tubevault/core';

/**
 * How gently yt-dlp paces itself (v1 YtdlpThrottle port). `null` = leave that
 * knob at yt-dlp's own default (no flag emitted); 0 is a real value ("this
 * sleep is off"), exactly like v1.
 */
export interface ThrottleConfig {
  /** Seconds between extraction (metadata) requests. */
  readonly sleepRequests: number | null;
  /** Min seconds before each download (randomized up to maxSleepInterval). */
  readonly sleepInterval: number | null;
  /** Max of the randomized pre-download sleep. */
  readonly maxSleepInterval: number | null;
  /** Download bandwidth cap, bytes/s (null = uncapped). */
  readonly limitRateBytes: number | null;
  /** Parallel fragment downloads (null = yt-dlp's safe 1). */
  readonly concurrentFragments: number | null;
  /** HTTP retries (tamed from yt-dlp's default 10). */
  readonly retries: number | null;
  /** Per-fragment retries (tamed from 10). */
  readonly fragmentRetries: number | null;
}

/** v1's gentle DEFAULTS-ON throttle: the single biggest free bot-wall lever. */
export const DEFAULT_THROTTLE: ThrottleConfig = {
  sleepRequests: 1.0,
  sleepInterval: 2.0,
  maxSleepInterval: 5.0,
  limitRateBytes: null,
  concurrentFragments: null,
  retries: 3,
  fragmentRetries: 5,
};

type Env = Readonly<Record<string, string | undefined>>;

const RATE_SUFFIXES: Readonly<Record<string, number>> = {
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
};

/** A human download-rate cap ('500K', '2M', '1048576') -> bytes/s; null when unset. */
function parseRate(value: string): number | null {
  let s = value.trim().toUpperCase();
  if (!s) {
    return null;
  }
  let mult = 1;
  const suffix = s[s.length - 1] as string;
  if (suffix in RATE_SUFFIXES) {
    mult = RATE_SUFFIXES[suffix] as number;
    s = s.slice(0, -1);
  }
  const n = Number(s);
  if (s.trim() === '' || !Number.isFinite(n)) {
    throw new Error(`TUBEVAULT_YTDLP_LIMIT_RATE must be a byte rate like '2M': ${value}`);
  }
  return Math.trunc(n * mult);
}

function optFloat(env: Env, name: string, fallback: number | null): number | null {
  const raw = (env[name] ?? '').trim();
  if (!raw) {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a number: ${raw}`);
  }
  return n;
}

function optInt(env: Env, name: string, fallback: number | null): number | null {
  const raw = (env[name] ?? '').trim();
  if (!raw) {
    return fallback;
  }
  if (!/^[+-]?\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer: ${raw}`);
  }
  return Number.parseInt(raw, 10);
}

/** v1 `YtdlpThrottle.__post_init__` validation. */
function validateThrottle(t: ThrottleConfig): ThrottleConfig {
  const nonNegative: readonly (readonly [string, number | null])[] = [
    ['sleepRequests', t.sleepRequests],
    ['sleepInterval', t.sleepInterval],
    ['maxSleepInterval', t.maxSleepInterval],
    ['limitRateBytes', t.limitRateBytes],
    ['concurrentFragments', t.concurrentFragments],
    ['retries', t.retries],
    ['fragmentRetries', t.fragmentRetries],
  ];
  for (const [name, value] of nonNegative) {
    if (value !== null && value < 0) {
      throw new Error(`ThrottleConfig.${name} must be non-negative`);
    }
  }
  if (
    t.sleepInterval !== null &&
    t.maxSleepInterval !== null &&
    t.maxSleepInterval < t.sleepInterval
  ) {
    throw new Error('ThrottleConfig.maxSleepInterval must be >= sleepInterval');
  }
  return t;
}

/**
 * Build the throttle from env — v1 `YtdlpThrottle.from_env` port with the EXACT
 * env names. Unset/blank knobs keep the gentle DEFAULTS-ON values; explicit `0`
 * turns a knob off (v1 semantics — there is deliberately NO master off switch).
 */
export function throttleConfigFromEnv(env: Env): ThrottleConfig {
  return validateThrottle({
    sleepRequests: optFloat(env, 'TUBEVAULT_YTDLP_SLEEP_REQUESTS', DEFAULT_THROTTLE.sleepRequests),
    sleepInterval: optFloat(env, 'TUBEVAULT_YTDLP_SLEEP_INTERVAL', DEFAULT_THROTTLE.sleepInterval),
    maxSleepInterval: optFloat(
      env,
      'TUBEVAULT_YTDLP_MAX_SLEEP_INTERVAL',
      DEFAULT_THROTTLE.maxSleepInterval,
    ),
    limitRateBytes: parseRate(env['TUBEVAULT_YTDLP_LIMIT_RATE'] ?? ''),
    concurrentFragments: optInt(
      env,
      'TUBEVAULT_YTDLP_CONCURRENT_FRAGMENTS',
      DEFAULT_THROTTLE.concurrentFragments,
    ),
    retries: optInt(env, 'TUBEVAULT_YTDLP_RETRIES', DEFAULT_THROTTLE.retries),
    fragmentRetries: optInt(
      env,
      'TUBEVAULT_YTDLP_FRAGMENT_RETRIES',
      DEFAULT_THROTTLE.fragmentRetries,
    ),
  });
}

/** How the engine runs yt-dlp (v1 RealArchiveEngine constructor knobs). */
export interface EngineConfig {
  readonly ytdlpBin: string;
  /** ffprobe binary for the verify flow (P6). Optional so test literals stay
   * terse; consumers fall back to `'ffprobe'` (runFfprobe's own default). */
  readonly ffprobeBin?: string;
  /** Outbound proxy (clean egress IP for a bot-flagged host). */
  readonly proxy?: string;
  /** youtube `player_client` override (e.g. 'android'); unset = yt-dlp default. */
  readonly playerClient?: string;
  /** Base URL of an optional self-hosted bgutil PO-token provider. */
  readonly potProviderUrl?: string;
  /** null = no pacing (test-only); production keeps the DEFAULTS-ON throttle. */
  readonly throttle: ThrottleConfig | null;
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  const v = (value ?? '').trim();
  return v ? v : undefined;
}

/** Engine config from env — the v1 `TUBEVAULT_YTDLP_*` names, throttle DEFAULTS-ON. */
export function engineConfigFromEnv(env: Env): EngineConfig {
  return {
    // TUBEVAULT_YTDLP_BIN: prod images leave it unset (yt-dlp on PATH); tests
    // point it at the committed fake-ytdlp fixture.
    ytdlpBin: trimmedOrUndefined(env['TUBEVAULT_YTDLP_BIN']) ?? 'yt-dlp',
    // TUBEVAULT_FFPROBE_BIN: prod worker images leave it unset (ffmpeg on
    // PATH); tests point it at the committed fake-ffprobe fixture.
    ffprobeBin: trimmedOrUndefined(env['TUBEVAULT_FFPROBE_BIN']) ?? 'ffprobe',
    proxy: trimmedOrUndefined(env['TUBEVAULT_YTDLP_PROXY']),
    playerClient: trimmedOrUndefined(env['TUBEVAULT_YTDLP_PLAYER_CLIENT']),
    potProviderUrl: trimmedOrUndefined(env['TUBEVAULT_YTDLP_POT_PROVIDER_URL']),
    throttle: throttleConfigFromEnv(env),
  };
}

/** Set (non-null) throttle knobs -> CLI flags (v1 `as_ydl_opts` mapped to CLI spellings). */
function throttleFlags(t: ThrottleConfig): string[] {
  const flags: readonly (readonly [string, number | null])[] = [
    ['--sleep-requests', t.sleepRequests],
    ['--sleep-interval', t.sleepInterval],
    ['--max-sleep-interval', t.maxSleepInterval],
    ['--limit-rate', t.limitRateBytes],
    ['--concurrent-fragments', t.concurrentFragments],
    ['--retries', t.retries],
    ['--fragment-retries', t.fragmentRetries],
  ];
  const argv: string[] = [];
  for (const [flag, value] of flags) {
    if (value !== null) {
      argv.push(flag, String(value));
    }
  }
  return argv;
}

/**
 * Identity + bot-wall flags WITHOUT the pacing knobs (proxy/player_client/pot/
 * cookies). The live capture composes on THIS (see liveCaptureArgs); everything
 * else goes through baseArgs, which adds the gentle throttle on top.
 * `--no-warnings` is v1's uniform `no_warnings` posture: WARNING lines must not
 * pollute the stderr tail that failure classification substring-matches (a
 * '429'-bearing WARNING could flip a terminal SOURCE_GONE into RATE_LIMITED).
 * v1's `quiet` deliberately has NO CLI counterpart here: `--quiet` would move
 * the progress template's screen output to stderr and break progress parsing.
 */
function identityArgs(config: EngineConfig, cookiesFile?: string): string[] {
  const argv: string[] = ['--socket-timeout', '30', '--no-warnings'];
  if (config.proxy) {
    argv.push('--proxy', config.proxy);
  }
  if (config.playerClient) {
    argv.push('--extractor-args', `youtube:player_client=${config.playerClient}`);
  }
  if (config.potProviderUrl) {
    argv.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${config.potProviderUrl}`);
  }
  if (cookiesFile) {
    argv.push('--cookies', cookiesFile);
  }
  return argv;
}

/**
 * Flags shared by every metadata/download yt-dlp invocation (v1 `_base_opts`
 * mapped to CLI): the identity/bot-wall flags PLUS the gentle DEFAULTS-ON
 * throttle. Live captures deliberately do NOT come through here — see
 * liveCaptureArgs.
 */
export function baseArgs(config: EngineConfig, cookiesFile?: string): string[] {
  const argv = identityArgs(config, cookiesFile);
  if (config.throttle !== null) {
    argv.push(...throttleFlags(config.throttle));
  }
  return argv;
}

/** One video download: everything the argv builders need (policy pre-resolved). */
export interface DownloadRequest {
  readonly url: string;
  readonly videoId: string;
  /** The per-video staging dir; yt-dlp writes `<id>.<ext>` + sidecars here. */
  readonly stagingDir: string;
  readonly qualityCap: QualityCap;
  readonly subtitleMode: SubtitleMode;
  readonly cookiesFile?: string;
  /** Write the `<id>.info.json` sidecar (v1 `write_info_json`; default true). */
  readonly writeInfoJson?: boolean;
  /** Write the thumbnail sidecar (v1 `write_thumbnail`; default true). */
  readonly writeThumbnail?: boolean;
}

const PROGRESS_TEMPLATE = 'download:TVPROG1 %(progress)j';

function outputTemplate(stagingDir: string): string {
  return join(stagingDir, '%(id)s.%(ext)s');
}

/**
 * The MEDIA pass argv: fail-loud, resumable, sentinel-prefixed JSON progress
 * on stdout — and deliberately WITHOUT subtitle flags, so a subtitle throttle
 * (429) can never fail the media download (v1 F4 lesson).
 *
 * `--continue` (the long spelling of `-c`) is EXPLICIT even though yt-dlp
 * resumes `.part` files by default: `-c` ALSO resumes fragment state (the
 * `.ytdl` sidecar) — PLAN.md verified fact — which the P7 pause/resume flow
 * depends on for DASH/fragmented downloads. Harmless on a clean dir: the
 * first execution of a Job row wipes staging before spawning.
 */
export function downloadArgs(config: EngineConfig, request: DownloadRequest): string[] {
  return [
    ...baseArgs(config, request.cookiesFile),
    '-f',
    formatSelector(request.qualityCap),
    '-o',
    outputTemplate(request.stagingDir),
    '--continue',
    ...((request.writeInfoJson ?? true) ? ['--write-info-json'] : []),
    ...((request.writeThumbnail ?? true) ? ['--write-thumbnail'] : []),
    '--no-playlist',
    '--newline',
    '--progress-template',
    PROGRESS_TEMPLATE,
    '--progress-delta',
    '0.5',
    '--color',
    'no_color',
    request.url,
  ];
}

/**
 * The best-effort SUBTITLE pass argv (`--skip-download`: the media is already
 * on disk). Returns null when the mode requests nothing (v1 guard — currently
 * unreachable with AUTO/MANUAL/BOTH, kept for a future NONE mode).
 */
export function subtitleArgs(config: EngineConfig, request: DownloadRequest): string[] | null {
  const decision = subtitleDecision(request.subtitleMode);
  if (!decision.writeSubtitles && !decision.writeAutomaticSub) {
    return null;
  }
  const argv = [...baseArgs(config, request.cookiesFile), '--skip-download'];
  if (decision.writeSubtitles) {
    argv.push('--write-subs');
  }
  if (decision.writeAutomaticSub) {
    argv.push('--write-auto-subs');
  }
  argv.push('--sub-langs', decision.subtitleLangs.join(','));
  argv.push('-o', outputTemplate(request.stagingDir), request.url);
  return argv;
}

/** Flat channel listing (v1 `_extract_flat`): no per-video network requests. */
export function enumerateArgs(config: EngineConfig, url: string, cookiesFile?: string): string[] {
  return [...baseArgs(config, cookiesFile), '--flat-playlist', '--dump-single-json', url];
}

/** Single-video metadata dump (v1 `_extract` with download=False). */
export function metadataArgs(config: EngineConfig, url: string, cookiesFile?: string): string[] {
  return [...baseArgs(config, cookiesFile), '--dump-single-json', '--no-download', url];
}

// ---------------------------------------------------------------------------
// Live probe + capture (P10, F3/D10)
// ---------------------------------------------------------------------------

/**
 * The canonical /live URL the probe resolves to a channel's current broadcast
 * (v1 `channel_live_url`). yt-dlp resolves `.../channel/<id>/live` to the live
 * video when the channel is live (and to nothing otherwise) — the dedicated
 * detection signal flat enumeration cannot give us. The immutable channel id
 * is the key (a handle can change).
 */
export function channelLiveUrl(channelId: string): string {
  return `https://www.youtube.com/channel/${channelId}/live`;
}

/**
 * Probe a channel for a current live broadcast: a metadata-style dump of its
 * /live URL (v1 `RealArchiveEngine.probe_live` used `_extract` with
 * download=False — exactly `metadataArgs`). Cookies thread through baseArgs so
 * members-only/age-gated lives are detectable with the owner session (F2).
 */
export function liveProbeArgs(
  config: EngineConfig,
  channelId: string,
  cookiesFile?: string,
): string[] {
  return metadataArgs(config, channelLiveUrl(channelId), cookiesFile);
}

/** One live recording: everything liveCaptureArgs needs (v1 LiveCaptureRequest). */
export interface LiveCaptureRequest {
  readonly url: string;
  readonly videoId: string;
  /** The live staging dir (`.incoming.live` under the video dir); yt-dlp records `<id>.<ext>` here. */
  readonly stagingDir: string;
  /** v1 runner passed UNLIMITED ("take the live stream as-is (policy cap TBD)"). */
  readonly qualityCap: QualityCap;
  readonly cookiesFile?: string;
}

/**
 * The live-capture argv — v1 `capture_subprocess.build_capture_argv` ported
 * EXACTLY, with the bot-wall IDENTITY levers composed through identityArgs
 * (cookies/proxy/player_client + v2's pot addition) and the THROTTLE/RETRY
 * knobs deliberately ABSENT: v1's capture argv (capture_subprocess.py:40-72)
 * passed NONE of them, and yt-dlp's own defaults (10 retries / 10 fragment
 * retries, no inter-request sleeps) are the loss-sensitive right call for a
 * one-shot live recording — a tamed retry ladder or a sleep between fragment
 * requests only widens the missed-bytes window on a broadcast that cannot be
 * refetched (PRD §8):
 *  - `--live-from-start` — record from the very beginning, never miss the
 *    opening (F3),
 *  - `--no-part` — write the media file directly so a kill leaves a PLAYABLE
 *    partial on disk (D10); also why there is no `--continue` here (the
 *    recording goes straight to the final name),
 *  - `--no-playlist` — the watch URL must never fan out.
 *
 * DELIBERATE v2 DEVIATION: v1 passed `--no-progress` (its capture never parsed
 * progress — on_progress was left as a "P11 nicety"). v2 emits the TVPROG1
 * sentinel stream instead, for byte TELEMETRY only — the byte-stall watchdog
 * still reads recorded bytes off the staging dir (dir-scan), never off this
 * stream, so a progress-format change can never mask a stall.
 */
export function liveCaptureArgs(config: EngineConfig, request: LiveCaptureRequest): string[] {
  return [
    ...identityArgs(config, request.cookiesFile),
    '-f',
    formatSelector(request.qualityCap),
    '-o',
    outputTemplate(request.stagingDir),
    '--live-from-start',
    '--no-playlist',
    '--no-part',
    '--newline',
    '--progress-template',
    PROGRESS_TEMPLATE,
    '--progress-delta',
    '0.5',
    '--color',
    'no_color',
    request.url,
  ];
}
