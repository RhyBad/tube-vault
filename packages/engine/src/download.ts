/**
 * Two-pass download orchestration (v1 `RealArchiveEngine.download` port):
 *
 * 1. MEDIA pass — fail-loud, subtitle-free. No subtitles are requested here, so
 *    the media archive can never be taken down by a subtitle endpoint throttle
 *    (the all-languages caption fetch on a popular video easily trips 429).
 * 2. SUBTITLE pass — `--skip-download`, BEST-EFFORT: subtitles are
 *    preservation-valuable but secondary; any failure is reported through the
 *    injected `warn` callback and swallowed, the saved media wins.
 * 3. Result via directory scan + info.json — never stdout.
 *
 * The engine NEVER wipes the staging dir: keep (pause/resume `.part`) vs wipe
 * (cancel/scratch-restart) is the worker's policy decision, not the engine's.
 */
import { registerCookieFileSecrets } from './cookies.js';
import { EngineError } from './errors.js';
import { parseProgressLine, type ProgressFrame } from './progress.js';
import { resolveDownloadResult, type ResolvedDownload } from './result-resolver.js';
import {
  downloadArgs,
  subtitleArgs,
  type DownloadRequest,
  type EngineConfig,
} from './ytdlp-args.js';
import { runYtdlp } from './ytdlp-runner.js';

export interface DownloadVideoOptions {
  /** Abort = cancel/pause: the media-pass child group is killed. */
  readonly signal?: AbortSignal;
  readonly onProgress?: (frame: ProgressFrame) => void;
  /** Receives the swallowed subtitle-pass failure (apps log it redacted). */
  readonly warn?: (message: string) => void;
  /** Exposes the media-pass child pid (kill probes/tests). */
  readonly onSpawn?: (pid: number) => void;
  /** SIGTERM -> SIGKILL escalation delay for aborts. */
  readonly killGraceMs?: number;
}

export type DownloadVideoOutcome =
  { readonly aborted: true } | { readonly aborted: false; readonly result: ResolvedDownload };

/**
 * Download one video into `request.stagingDir`. Aborted -> `{aborted: true}`
 * (staging kept, `.part` intact); media-pass failure -> EngineError carrying
 * the stderr tail (callers classify via @tubevault/core).
 */
export async function downloadVideo(
  config: EngineConfig,
  request: DownloadRequest,
  options: DownloadVideoOptions = {},
): Promise<DownloadVideoOutcome> {
  const { signal, onProgress, warn, onSpawn, killGraceMs } = options;

  if (request.cookiesFile !== undefined) {
    // v1 D7 posture: register at EVERY use, however the file was materialized
    // (writeCookiesTempFile registers too, but callers may bring their own).
    await registerCookieFileSecrets(request.cookiesFile);
  }

  const media = await runYtdlp(config.ytdlpBin, downloadArgs(config, request), {
    signal,
    onSpawn,
    killGraceMs,
    onLine: (line) => {
      const frame = parseProgressLine(line);
      if (frame !== null) {
        onProgress?.(frame);
      }
    },
  });
  if (media.aborted) {
    return { aborted: true };
  }
  if (media.exitCode !== 0) {
    throw new EngineError(
      `yt-dlp media download failed (exit ${media.exitCode}) for ${request.url}`,
      media.stderrTail,
    );
  }

  const subArgs = subtitleArgs(config, request);
  if (subArgs !== null) {
    try {
      const subs = await runYtdlp(config.ytdlpBin, subArgs, { signal, killGraceMs });
      if (!subs.aborted && subs.exitCode !== 0) {
        warn?.(
          `subtitles incomplete for ${request.videoId} (media preserved): ` +
            `exit ${subs.exitCode}: ${subs.stderrTail.join(' | ')}`,
        );
      }
    } catch (err) {
      warn?.(
        `subtitles incomplete for ${request.videoId} (media preserved): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const result = await resolveDownloadResult(request.stagingDir, request.videoId);
  return { aborted: false, result };
}
