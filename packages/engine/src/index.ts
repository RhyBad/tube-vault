/**
 * @tubevault/engine — the yt-dlp + ffprobe SUBPROCESS adapter (P3).
 *
 * The ONLY package that talks to yt-dlp/ffprobe. Decisions stay pure
 * (@tubevault/core: formatSelector/subtitleDecision/classification); this layer
 * is argv building, process supervision, progress telemetry, dir-scan result
 * resolution, and cookie/secret hygiene. Contract-tested against the committed
 * fake-ytdlp fixture always, and real yt-dlp behind TUBEVAULT_SMOKE=1.
 */
export * from './cookies.js';
export * from './download.js';
export * from './errors.js';
export * from './ffprobe.js';
export * from './probe.js';
export * from './progress.js';
export * from './result-resolver.js';
export * from './unresumable.js';
export * from './ytdlp-args.js';
export * from './ytdlp-mapping.js';
export * from './ytdlp-runner.js';
