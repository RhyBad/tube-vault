/**
 * Shared transport/domain types (web + api + worker).
 *
 * DB row types will live in `@tubevault/db` (backend-only, Prisma). Enums are
 * mirrored here as string unions so the frontend never depends on Prisma.
 */
export * from './notifications.js';

/**
 * Lifecycle of the copy TubeVault holds (v1 CopyState + the CR-20
 * `AWAITING_VERIFY` park: a finished live capture whose completeness can't be
 * measured yet, awaiting the re-check sweep).
 */
export type CopyState =
  | 'CANDIDATE'
  | 'QUEUED'
  | 'DOWNLOADING'
  | 'VERIFYING'
  | 'AWAITING_VERIFY'
  | 'HEALTHY'
  | 'FAILED'
  | 'PARTIAL_KEPT';

/** Observed availability of the original on YouTube (v1 SourceState). */
export type SourceState =
  | 'AVAILABLE'
  | 'GEO_BLOCKED'
  | 'PRIVATE'
  | 'MEMBERS_ONLY'
  | 'AGE_GATED'
  | 'DELETED'
  | 'TRANSIENT_ERROR'
  | 'RATE_LIMITED'
  | 'UNKNOWN';

export type ContentType = 'REGULAR' | 'SHORTS' | 'PREMIERE' | 'LIVE' | 'MEMBERS_ONLY';

export type JobType =
  'DOWNLOAD' | 'VERIFY' | 'ENUMERATE' | 'LIVE_PROBE' | 'LIVE_CAPTURE' | 'SOURCE_CHECK';

/** Durable job lifecycle — the DB row is the source of truth; BullMQ jobs are executions. */
export type JobStatus = 'QUEUED' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'FAILED' | 'CANCELED';

export type ErrorKind =
  'BOT_WALL' | 'RATE_LIMITED' | 'AUTH' | 'GEO_BLOCKED' | 'SOURCE_GONE' | 'TRANSIENT' | 'UNKNOWN';

/** Global quality ceiling (mirror of the Prisma QualityCap enum). */
export type QualityCap = 'UNLIMITED' | 'P2160' | 'P1440' | 'P1080' | 'P720';

/**
 * Subtitle acquisition mode (mirror of the Prisma SubtitleMode enum). NOTE:
 * this is the SETTINGS union — it includes 'NONE' (subtitles off), which
 * @tubevault/core's policy SubtitleMode deliberately lacks (core only decides
 * WHICH subs to fetch; "fetch none" is a service-layer switch).
 */
export type SubtitleMode = 'NONE' | 'MANUAL' | 'AUTO' | 'BOTH';

/** JobEvent log-line severity (mirror of the Prisma LogLevel enum). */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['COMPLETED', 'FAILED', 'CANCELED'];

export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ['QUEUED', 'RUNNING', 'PAUSED'];

/** True when the job can never run again (its queue-item row is history, not work). */
export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}

/** True while the job occupies the queue (waiting, running, or paused-with-partial). */
export function isActiveJobStatus(status: JobStatus): boolean {
  return ACTIVE_JOB_STATUSES.includes(status);
}

/**
 * Live-capture session lifecycle (mirror of the Prisma LiveSessionState enum).
 * `ENDED_PENDING` (CR-20): capture ended, completeness re-check pending — OUT of
 * the active set ({DETECTED, CAPTURING}), so re-detection isn't blocked.
 */
export type LiveSessionState =
  'DETECTED' | 'CAPTURING' | 'ENDED_NORMAL' | 'ENDED_INTERRUPTED' | 'FAILED' | 'ENDED_PENDING';

// ---------------------------------------------------------------------------
// Redis pub/sub contract (PLAN.md "Queue mechanics"): worker → api → SSE.
// ---------------------------------------------------------------------------

/** Worker publishes throttled (≤4Hz/job) download progress here; the api fans it out over SSE. */
export const REDIS_CHANNEL_JOB_PROGRESS = 'job:progress';
/** Worker publishes UNthrottled job state changes here (QUEUED/RUNNING/… transitions). */
export const REDIS_CHANNEL_JOB_CHANGED = 'job:changed';
/** Api publishes cancel/pause commands here; the worker's control-subscriber acts on them. */
export const REDIS_CHANNEL_JOB_CONTROL = 'job:control';
/** Worker publishes video copy/source-state changes here (every VideoStateService transition). */
export const REDIS_CHANNEL_VIDEO_CHANGED = 'video:changed';
/** Api publishes queue-order changes here (move/renumber, P7); SSE clients refetch on it. */
export const REDIS_CHANNEL_QUEUE_REORDERED = 'queue:reordered';
/** Live worker publishes LiveSession state changes here (DETECTED/CAPTURING/ENDED_*, P10). */
export const REDIS_CHANNEL_LIVE_CHANGED = 'live:changed';

export type JobControlAction = 'cancel' | 'pause';

// ---------------------------------------------------------------------------
// BullMQ queue names — they live HERE so the api (producer) and the worker
// (consumer) can never drift apart on a string. Sibling of the REDIS_CHANNEL_*
// pub/sub names above; the DOWNLOAD/VERIFY queues join in P6.
// ---------------------------------------------------------------------------

/** Channel back-catalog enumeration jobs (api enqueues, archive worker consumes). */
export const BULLMQ_QUEUE_ENUMERATE = 'enumerate';

/** Per-video download jobs (api enqueues in P6b, archive worker consumes). */
export const BULLMQ_QUEUE_DOWNLOAD = 'download';

/** Post-download integrity-verification jobs (chained by the download processor). */
export const BULLMQ_QUEUE_VERIFY = 'verify';

/**
 * The live-scan scheduler ticks (P10): a repeatable produced every 30s by
 * `upsertJobScheduler` on the LIVE worker role. Ticks carry no Job row — they
 * are pure scheduler beats that fan due channels out into live-probe jobs.
 */
export const BULLMQ_QUEUE_LIVE_SCAN = 'live-scan';

/** Per-channel /live-resolution probes (live worker enqueues + consumes). */
export const BULLMQ_QUEUE_LIVE_PROBE = 'live-probe';

/** Long-running live recordings (live worker; maxStalledCount 0, lockDuration 60s). */
export const BULLMQ_QUEUE_LIVE_CAPTURE = 'live-capture';

/**
 * CR-09 re-enumeration scheduler ticks: a repeatable produced by
 * `upsertJobScheduler` on the ARCHIVE worker role. Like live-scan, ticks carry
 * no Job row — they fan due channels out into ordinary `enumerate` jobs.
 */
export const BULLMQ_QUEUE_REENUMERATE_SCAN = 'reenumerate-scan';

/**
 * CR-09 source-recheck scheduler ticks (archive role): fans due held videos out
 * into per-video `source-check` jobs. No Job row for the tick itself.
 */
export const BULLMQ_QUEUE_SOURCE_CHECK_SCAN = 'source-check-scan';

/** Per-video original-availability probes (archive worker enqueues + consumes, CR-09). */
export const BULLMQ_QUEUE_SOURCE_CHECK = 'source-check';

/**
 * CR-20 completeness re-check sweep (archive role): fans due AWAITING_VERIFY
 * live captures out for re-measurement. Like `source-check-scan`, the tick has
 * no Job row of its own — the sweep resolves each due video IN PLACE (no
 * per-video COMPLETENESS_CHECK rows; parked captures are few and short-lived).
 */
export const BULLMQ_QUEUE_COMPLETENESS_SCAN = 'completeness-scan';

/**
 * The BullMQ add-options subset TubeVault uses. Structurally compatible with
 * bullmq's `JobsOptions` WITHOUT importing bullmq (this package stays
 * dependency-free and browser-safe); both the api producer (P6b) and the
 * worker (verify chain + boot reconciler) must build options through the
 * helpers below so the retry policy can never drift between them.
 */
export interface QueueAddOptions {
  /** BullMQ jobId — ALWAYS the durable Job-row id (PLAN.md: row-first). */
  jobId: string;
  /** Explicit priority (downloads only): priority-less jobs beat ALL prioritized ones. */
  priority?: number;
  attempts: number;
  backoff: { type: 'exponential' | 'fixed'; delay: number };
  removeOnComplete: true;
  removeOnFail: true;
}

/** BullMQ's maximum job priority (2^21); 1 is the strongest prioritized value. */
export const BULLMQ_PRIORITY_MAX = 2_097_152;

/**
 * THE canonical DOWNLOAD add-options (PLAN.md retry policy: transient failures
 * retry `attempts: 5` with exponential backoff from 30s; terminal classes throw
 * UnrecoverableError and never reach the retry ladder). `priority` mirrors the
 * Job row's gap-based priority and is REQUIRED-VALID: BullMQ treats 0/null/
 * absent as "no priority", which BEATS every prioritized job — a silently
 * queue-jumping download. Throws RangeError on anything outside the integer
 * range [1, BULLMQ_PRIORITY_MAX].
 */
export function downloadAddOptions(jobRowId: string, priority: number): QueueAddOptions {
  if (!Number.isInteger(priority) || priority < 1 || priority > BULLMQ_PRIORITY_MAX) {
    throw new RangeError(
      `download priority must be an integer in [1, ${BULLMQ_PRIORITY_MAX}], got ${String(priority)} ` +
        '(BullMQ treats 0/null/absent as "no priority", which BEATS all prioritized jobs)',
    );
  }
  return {
    jobId: jobRowId,
    priority,
    attempts: 5,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: true,
    removeOnFail: true,
  };
}

/** THE canonical VERIFY add-options: attempts 3, exponential backoff 30s, no priority. */
export function verifyAddOptions(jobRowId: string): QueueAddOptions {
  return {
    jobId: jobRowId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: true,
    removeOnFail: true,
  };
}

/**
 * THE canonical ENUMERATE add-options: attempts 3, exponential backoff 30s, no
 * priority. Both producers — the api (channels.service) and the worker's boot
 * reconciler — MUST build through this so the retry policy can never drift.
 */
export function enumerateAddOptions(jobRowId: string): QueueAddOptions {
  return {
    jobId: jobRowId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: true,
    removeOnFail: true,
  };
}

/**
 * THE canonical LIVE_PROBE add-options: attempts 1, no retry ladder — a probe
 * is cheap and the next 30s scan tick of a still-due channel re-probes anyway,
 * so a BullMQ retry would only double-poll YouTube (bot-wall posture).
 */
export function liveProbeAddOptions(jobRowId: string): QueueAddOptions {
  return {
    jobId: jobRowId,
    attempts: 1,
    backoff: { type: 'fixed', delay: 0 }, // moot at attempts 1 (shape parity)
    removeOnComplete: true,
    removeOnFail: true,
  };
}

/**
 * THE canonical LIVE_CAPTURE add-options: attempts 1 — capture restarts are
 * SESSION-level decisions, never BullMQ retries. A failed/stalled capture
 * finalizes its LiveSession (partial kept, D10) and the next scan tick
 * re-probes a still-live stream into a FRESH session/capture; a blind BullMQ
 * re-execution of the same row would race that fresh session for the
 * ux_live_session_active unique.
 */
export function liveCaptureAddOptions(jobRowId: string): QueueAddOptions {
  return {
    jobId: jobRowId,
    attempts: 1,
    backoff: { type: 'fixed', delay: 0 }, // moot at attempts 1 (shape parity)
    removeOnComplete: true,
    removeOnFail: true,
  };
}

/**
 * THE canonical SOURCE_CHECK add-options (CR-09): attempts 1 (live-probe
 * parity). The probe classifies every availability answer — including
 * rate-limit/transient — to a SourceState the processor records; it never
 * throws for those. So there is nothing a BullMQ retry would fix: whatever
 * isn't confirmed this cycle is simply re-probed next cadence tick, and a
 * genuinely dead execution is re-added by the archive boot reconciler.
 */
export function sourceCheckAddOptions(jobRowId: string): QueueAddOptions {
  return {
    jobId: jobRowId,
    attempts: 1,
    backoff: { type: 'fixed', delay: 0 }, // moot at attempts 1 (shape parity)
    removeOnComplete: true,
    removeOnFail: true,
  };
}

/** Message on `job:control`: kill the yt-dlp child group (cancel wipes staging, pause keeps it). */
export interface JobControlMessage {
  action: JobControlAction;
  jobId: string;
}

// ---------------------------------------------------------------------------
// SSE frames (PLAN.md `GET /api/events`): heartbeat, job.progress, job.changed,
// video.changed, live.changed, queue.reordered. Every frame discriminates on
// `type` so the web client can switch exhaustively.
// ---------------------------------------------------------------------------

export interface HeartbeatFrame {
  type: 'heartbeat';
  /** Server wall-clock ms — lets the client detect a stalled stream. */
  ts: number;
}

/** Progress snapshot for one running job (mirrors the Job row's progress fields). */
export interface JobProgressPayload {
  jobId: string;
  videoId: string | null;
  pct: number;
  downloadedBytes: number;
  totalBytes: number | null;
  speedBps: number | null;
  etaSeconds: number | null;
  currentFile: string | null;
}

export interface JobProgressFrame {
  type: 'job.progress';
  payload: JobProgressPayload;
}

/** A Job row changed status (unthrottled; the client refetches details as needed). */
export interface JobChangedPayload {
  jobId: string;
  type: JobType;
  status: JobStatus;
  videoId: string | null;
  errorKind: ErrorKind | null;
}

export interface JobChangedFrame {
  type: 'job.changed';
  payload: JobChangedPayload;
}

export interface VideoChangedPayload {
  videoId: string;
  channelId: string;
  copyState: CopyState;
  sourceState: SourceState;
}

export interface VideoChangedFrame {
  type: 'video.changed';
  payload: VideoChangedPayload;
}

export interface LiveChangedPayload {
  videoId: string;
  channelId: string;
  state: LiveSessionState;
  /** The LiveSession row id (dashboard drill-down); absent on legacy frames. */
  sessionId?: string;
}

export interface LiveChangedFrame {
  type: 'live.changed';
  payload: LiveChangedPayload;
}

/** The `queue:reordered` Redis payload (move/renumber): just the server timestamp. */
export interface QueueReorderedPayload {
  ts: number;
}

/** Queue order changed (move/renumber); carries no detail — the client refetches the queue. */
export interface QueueReorderedFrame {
  type: 'queue.reordered';
  ts: number;
}

export type SseFrame =
  | HeartbeatFrame
  | JobProgressFrame
  | JobChangedFrame
  | VideoChangedFrame
  | LiveChangedFrame
  | QueueReorderedFrame;

// ---------------------------------------------------------------------------
// Channels/videos REST DTOs (P5). Browser-safe: Dates travel as ISO strings,
// BigInt byte counts as `number` (the api's DTO mappers convert — raw Prisma
// rows never cross the JSON boundary).
// ---------------------------------------------------------------------------

export interface ChannelVideoCounts {
  total: number;
  /** copyState = CANDIDATE (browse-and-select fodder). */
  candidates: number;
  /** copyState = HEALTHY (verified archived copies). */
  healthy: number;
}

export interface ChannelDto {
  /** The immutable YouTube channel id (`UC…`). */
  id: string;
  url: string;
  title: string;
  handle: string | null;
  watchLive: boolean;
  /**
   * CR-04 per-channel download-policy overrides. `null` = inherit the global
   * Settings value (mirrors the nullable `Channel.qualityCap?/subtitleMode?`
   * columns). Patchable via EP-12. (Per-channel content-type policy is a
   * separate, not-yet-implemented CR — deliberately absent here.)
   */
  qualityCap: QualityCap | null;
  subtitleMode: SubtitleMode | null;
  /**
   * CR-06: `null` = active (registered). A timestamp = "unregistered" — the
   * archive is kept & served but collection (re-enumeration + live scan) has
   * stopped for this channel. Re-registering clears it. (A hard delete removes
   * the channel entirely, so it never appears with a timestamp here.)
   */
  unregisteredAt: string | null;
  lastEnumeratedAt: string | null;
  createdAt: string;
  videoCounts: ChannelVideoCounts;
}

export interface VideoDto {
  /** The YouTube video id. */
  id: string;
  channelId: string;
  title: string;
  contentType: ContentType;
  copyState: CopyState;
  sourceState: SourceState;
  publishedAt: string | null;
  addedAt: string;
  mediaExt: string | null;
  /** BigInt in the DB; a plain number here (safe: < 2^53 bytes = 8 PiB). */
  sizeBytes: number | null;
  /** Verify-time sha256 of the preserved media (hex); null until HEALTHY. */
  checksumSha256: string | null;
  width: number | null;
  height: number | null;
  sourceDurationSeconds: number | null;
}

/** `POST /api/channels` body. */
export interface RegisterChannelRequest {
  url: string;
}

/** `POST /api/channels` response: the (possibly pre-existing) channel + its enumerate job. */
export interface RegisterChannelResponse {
  channel: ChannelDto;
  /** The durable Job-row id (also the BullMQ jobId) of the active ENUMERATE job. */
  enumerateJobId: string;
  /** True when the channel row already existed (registration is idempotent). */
  alreadyRegistered: boolean;
}

/** `GET /api/channels` response. */
export interface ChannelListResponse {
  channels: ChannelDto[];
}

/**
 * `DELETE /api/channels/:id` response (CR-06). Two modes:
 * - `unregistered` (default): the channel is soft-disabled — collection stops
 *   but the Channel row, Video rows and disk media are KEPT (`videosDeleted:0`,
 *   `mediaPurged:false`). Reversible by re-registering.
 * - `purged` (`?purgeMedia=true`): hard delete — the Channel row + all its Video
 *   rows are removed (cascade) and the on-disk media is wiped
 *   (`mediaPurged:true`, `videosDeleted` = how many Video rows were removed).
 */
export interface DeleteChannelResponse {
  channelId: string;
  mode: 'unregistered' | 'purged';
  videosDeleted: number;
  mediaPurged: boolean;
}

/** `GET /api/channels/:id/videos` response (`total` counts the FILTERED set). */
export interface ChannelVideosResponse {
  videos: VideoDto[];
  total: number;
}

/**
 * One active live-capture session (EP-35 snapshot row). `title`/`channelTitle`
 * are joined in for display so the client never N+1s; `channelId` is the
 * session's own column. Dates travel as ISO strings. `captureJobId` is null
 * until a LIVE_CAPTURE is enqueued; `lastHeartbeatAt` is null before the first
 * capture heartbeat.
 */
export interface LiveSessionDto {
  /** The LiveSession row id (cuid). */
  sessionId: string;
  videoId: string;
  title: string;
  channelId: string;
  channelTitle: string;
  state: LiveSessionState;
  captureJobId: string | null;
  lastHeartbeatAt: string | null;
  startedAt: string;
}

/**
 * `GET /api/live-sessions` response (EP-35, read-only): the CURRENTLY active
 * sessions (state ∈ {DETECTED, CAPTURING}), newest first. This is the initial
 * snapshot only — subsequent transitions arrive as `live.changed` SSE frames
 * (EP-09). Active sessions are few, so there is no pagination.
 */
export interface LiveSessionListResponse {
  sessions: LiveSessionDto[];
}

/** `POST /api/videos/add-url` body. */
export interface AddVideoByUrlRequest {
  url: string;
}

/** `POST /api/videos/add-url` response (`created` false = it already existed). */
export interface AddVideoByUrlResponse {
  video: VideoDto;
  created: boolean;
}

/**
 * Sort orders for the channel-videos listing (publishedAt/sizeBytes sorts are
 * nulls-last). CR-27 adds `sizeBytes_*` so the cleanup UI can surface the biggest
 * reclaim targets first.
 */
export type VideoSort =
  | 'publishedAt_desc'
  | 'publishedAt_asc'
  | 'addedAt_desc'
  | 'title_asc'
  | 'sizeBytes_desc'
  | 'sizeBytes_asc';

// ---------------------------------------------------------------------------
// Global videos REST DTOs (P9): the cross-channel listing (Search page) and
// the single-video detail (Video page). Same query semantics as the
// per-channel listing; items additionally carry the channel title.
// ---------------------------------------------------------------------------

/** Which state machine a VideoStatusEvent row belongs to (Prisma StatusAxis mirror). */
export type StatusAxis = 'COPY' | 'SOURCE';

/** A VideoDto that also names its channel (cross-channel tables). */
export interface VideoWithChannelDto extends VideoDto {
  channelTitle: string;
}

/** `GET /api/videos` response (`total` counts the FILTERED set, like per-channel). */
export interface VideoListResponse {
  videos: VideoWithChannelDto[];
  total: number;
}

/** One append-only status transition (the Video page's trail), oldest first. */
export interface VideoStatusEventDto {
  axis: StatusAxis;
  from: string;
  to: string;
  note: string;
  at: string;
}

/**
 * `GET /api/videos/:id` response. The detail-only fields (`description`,
 * `activeDownloadJobId`, `activeDownloadStatus`) live on THIS envelope, NOT on
 * the shared `VideoDto` — the cross-channel/per-channel listings (EP-13/EP-15)
 * stay a lean projection.
 */
export interface VideoDetailResponse {
  video: VideoDto;
  channelTitle: string;
  /**
   * The video's long-form description (CR-14). Null until a full-metadata
   * acquisition (`POST /api/videos/add-url`) captures it — flat channel
   * enumeration carries none, so channel-listed candidates read null.
   */
  description: string | null;
  /**
   * The id of the video's currently-active DOWNLOAD job, or null when none is
   * active (CR-16). At most one exists — the `ux_job_active_download` partial
   * unique (`type=DOWNLOAD AND status ∈ {QUEUED,RUNNING,PAUSED}`) guarantees it.
   */
  activeDownloadJobId: string | null;
  /** The active DOWNLOAD job's status (mirrors `activeDownloadJobId`; null together). */
  activeDownloadStatus: JobStatus | null;
  /** Ascending by time — render top-down as "how this copy got here". */
  events: VideoStatusEventDto[];
}

// ---------------------------------------------------------------------------
// Subtitle serving DTOs (CR-17): the Video page's <track> list + the WebVTT
// serve endpoint. Subtitles are best-effort preserved by the download flow as
// `<videoId>.<lang>.<ext>` sidecars; these are read-only projections of what is
// on disk (no schema/worker). Only the <track>-viable formats are offered.
// ---------------------------------------------------------------------------

/** One preserved subtitle track (`GET /api/media/:videoId/subtitles`). */
export interface SubtitleTrackDto {
  /** BCP-47-ish language tag from the sidecar filename (e.g. 'en', 'en-US'). */
  lang: string;
  /** Human display label derived from `lang`; omitted when unresolvable. */
  label?: string;
  /**
   * The format STORED on disk. Serving ALWAYS yields WebVTT — an 'srt' track is
   * converted on the fly — so `format` is informational (what is preserved),
   * not the served content-type.
   */
  format: 'vtt' | 'srt';
}

/** `GET /api/media/:videoId/subtitles` response (the video's preserved tracks). */
export interface SubtitleListResponse {
  subtitles: SubtitleTrackDto[];
}

// ---------------------------------------------------------------------------
// Queue REST DTOs (P6b — PLAN.md "Queue API surface"). Browser-safe: Dates as
// ISO strings, BigInt byte counts as numbers (mapper-only boundary).
// ---------------------------------------------------------------------------

/** Copy states a video may be ENQUEUED from (PLAN.md enqueue filter). */
export type EnqueueableCopyState = 'CANDIDATE' | 'FAILED' | 'PARTIAL_KEPT';

/**
 * Runtime mirror of EnqueueableCopyState (drives the api's filter default AND
 * its zod body enum — a tuple type so z.enum can derive from it directly).
 */
export const ENQUEUEABLE_COPY_STATES = [
  'CANDIDATE',
  'FAILED',
  'PARTIAL_KEPT',
] as const satisfies readonly EnqueueableCopyState[];

/** `POST /api/queue/enqueue` body: explicit ids, a filter selection, or both (union, deduped). */
export interface EnqueueRequest {
  videoIds?: string[];
  filter?: {
    channelId?: string;
    /** Omitted = all three enqueue-eligible states. */
    copyState?: EnqueueableCopyState;
    /** Case-insensitive title-contains. */
    search?: string;
  };
}

/**
 * Why a requested video was NOT enqueued:
 *  - not_found            — no such video row,
 *  - not_eligible         — copyState outside {CANDIDATE, FAILED, PARTIAL_KEPT}
 *                           (incl. already-QUEUED videos), or lost the enqueue CAS,
 *  - live_retry_refused   — LIVE content retried from FAILED/PARTIAL_KEPT (PRD §8:
 *                           never refetch a post-live VOD; a CANDIDATE LIVE is fine),
 *  - already_queued       — the ux_job_active_download partial unique fired
 *                           (an active DOWNLOAD row already owns the video),
 *  - live_capture_active  — an active LIVE_CAPTURE row owns the video (P10
 *                           double-writer guard: a download racing an in-flight
 *                           recording would fight it for the video's copy state),
 *  - enqueue_failed       — the row committed but the post-commit BullMQ add
 *                           was rejected (rare Redis-outage path) and the api
 *                           COMPENSATED: row → FAILED, video → CANDIDATE — the
 *                           video is immediately re-enqueueable.
 */
export type EnqueueSkipReason =
  | 'not_found'
  | 'not_eligible'
  | 'live_retry_refused'
  | 'already_queued'
  | 'live_capture_active'
  | 'enqueue_failed';

/** Runtime mirror of EnqueueSkipReason (UI switches / test exhaustiveness). */
export const ENQUEUE_SKIP_REASONS: readonly EnqueueSkipReason[] = [
  'not_found',
  'not_eligible',
  'live_retry_refused',
  'already_queued',
  'live_capture_active',
  'enqueue_failed',
];

/** `POST /api/queue/enqueue` response (`enqueued` preserves processing order). */
export interface EnqueueResponse {
  /** Video ids now owned by a fresh QUEUED DOWNLOAD job, in enqueue order. */
  enqueued: string[];
  skipped: { videoId: string; reason: EnqueueSkipReason }[];
}

// ---------------------------------------------------------------------------
// CR-27 — video-level deletion / space reclamation (EP-39 single, EP-40 bulk)
// ---------------------------------------------------------------------------

/**
 * The two delete modes (mirror EP-38's soft/hard at the video grain):
 * - `reclaim` — delete the media, clear its metadata, copyState → CANDIDATE
 *   (KEEP the row → re-downloadable via EP-19). Space-freeing, reversible-ish.
 * - `purge`   — delete the media AND the Video row (cascades its jobs/session/
 *   status events). Permanent.
 */
export type VideoDeleteMode = 'reclaim' | 'purge';

/**
 * Why a video was NOT deleted (per-id verdict, like {@link EnqueueSkipReason}):
 * - `not_found`    — no such Video row.
 * - `active_job`   — an active DOWNLOAD (QUEUED/RUNNING/PAUSED) or LIVE_CAPTURE
 *   owns it; the caller must cancel first (per-video cleanup never auto-cancels).
 * - `not_eligible` — RECLAIM of a video that holds no media (CANDIDATE/0-byte) —
 *   nothing to free.
 * - `fs_error`     — the DB change committed (it is the truth) but the on-disk
 *   media wipe failed; the id is reported here so the caller knows disk cleanup
 *   was incomplete (it is NOT counted in `freedBytes`).
 */
export type VideoDeleteReason = 'not_found' | 'active_job' | 'not_eligible' | 'fs_error';

/** Runtime mirror of {@link VideoDeleteReason} (UI switches / test exhaustiveness). */
export const VIDEO_DELETE_REASONS: readonly VideoDeleteReason[] = [
  'not_found',
  'active_job',
  'not_eligible',
  'fs_error',
];

/**
 * `DELETE /api/videos/:id` and `POST /api/videos/delete` share this shape —
 * always HTTP 200, per-id verdicts in the body (destructive-verb philosophy, like
 * EP-25). `freedBytes` = Σ prior `sizeBytes` of the ids in `deleted` (fs_error ids
 * are in `failed`, excluded — their space was not actually freed).
 */
export interface DeleteVideosResponse {
  deleted: string[];
  freedBytes: number;
  failed: { videoId: string; reason: VideoDeleteReason }[];
}

/** Live progress numbers for one queue item (BigInt bytes → number at the mapper). */
export interface QueueItemProgress {
  pct: number;
  downloadedBytes: number;
  totalBytes: number | null;
  speedBps: number | null;
  etaSeconds: number | null;
  currentFile: string | null;
}

/** One row of `GET /api/queue` (a DOWNLOAD Job joined with its video + channel). */
export interface QueueItemDto {
  jobId: string;
  videoId: string;
  title: string;
  channelId: string;
  channelTitle: string;
  status: JobStatus;
  /** The gap-based order mirror; null only on legacy/degenerate rows. */
  priority: number | null;
  attempt: number;
  /**
   * Non-null for RUNNING / PAUSED / COMPLETED rows (a paused bar keeps its
   * numbers, a finished bar reads its final ones); null for QUEUED / FAILED /
   * CANCELED (the recorder zeroes those — a queued row showing 87% would lie).
   */
  progress: QueueItemProgress | null;
  errorKind: ErrorKind | null;
  error: string | null;
  enqueuedAt: string;
  startedAt: string | null;
  /** When the row was PAUSED (P7 pause/resume contract); null otherwise. */
  pausedAt: string | null;
  finishedAt: string | null;
}

/** `GET /api/queue` response: keyset-paged (opaque cursor; null = last page). */
export interface QueueListResponse {
  items: QueueItemDto[];
  nextCursor: string | null;
}

/**
 * `POST /api/queue/:jobId/move` body — EXACTLY one form (P7): a named end of
 * the queue, or "insert after this job" (midpoint slot).
 */
export type QueueMoveRequest = { position: 'top' | 'bottom' } | { afterJobId: string };

/** `POST /api/queue/:jobId/move` response (`renumbered` = the whole active set was re-spaced). */
export interface QueueMoveResponse {
  moved: true;
  /** The moved row's NEW gap-grid priority (also mirrored on its BullMQ job when QUEUED). */
  priority: number;
  renumbered: boolean;
}

/** `POST /api/queue/bulk` actions — each runs the corresponding single-item flow per id. */
export type QueueBulkAction = 'cancel' | 'pause' | 'resume';

/** `POST /api/queue/bulk` body (1..500 ids). */
export interface QueueBulkRequest {
  action: QueueBulkAction;
  jobIds: string[];
}

/**
 * Why one id of a bulk request failed (mapped from the single-item outcome):
 *  - not_found            — no such Job row (404),
 *  - wrong_type           — not a DOWNLOAD row / malformed request (400),
 *  - conflict             — wrong state for the action (409: already settled /
 *                           already paused / not paused / already started),
 *  - control_unavailable  — a Redis-path 503: the RUNNING-row control publish
 *                           failed, the resume re-add failed (the row is put
 *                           back PAUSED), or the previous execution was still
 *                           settling — every shape is retryable as-is,
 *  - error                — anything else (a genuine 5xx surprise).
 */
export type QueueBulkFailureReason =
  'not_found' | 'wrong_type' | 'conflict' | 'control_unavailable' | 'error';

/** `POST /api/queue/bulk` response: ALWAYS 200 with the per-id breakdown. */
export interface QueueBulkResponse {
  ok: string[];
  failed: { jobId: string; reason: QueueBulkFailureReason }[];
}

/** One JobEvent log line (`GET /api/queue/:jobId/events` drill-down). */
export interface JobEventDto {
  id: string;
  level: LogLevel;
  message: string;
  context: unknown;
  createdAt: string;
}

/** `GET /api/queue/:jobId/events` response (ascending by time). */
export interface JobEventsResponse {
  events: JobEventDto[];
}

// ---------------------------------------------------------------------------
// Settings REST DTOs (P6b): the Settings singleton, read + partial update.
// ---------------------------------------------------------------------------

/**
 * Download-concurrency clamp bounds, defined ONCE so the api's settings PATCH
 * clamp and the worker's per-pickup clamp (apps/worker/src/jobs/
 * download-concurrency.ts) can never drift. Serial 1 is the bot-wall-gentle
 * default; 4 is the home-NAS ceiling.
 */
export const CONCURRENCY_MIN = 1;
export const CONCURRENCY_MAX = 4;

/** `GET /api/settings` response — the singleton row, verbatim. */
export interface SettingsDto {
  downloadConcurrency: number;
  qualityCap: QualityCap;
  subtitleMode: SubtitleMode;
}

/**
 * `PATCH /api/settings` body — all fields optional. `downloadConcurrency` is
 * CLAMPED to [1,4] server-side (never rejected: the worker clamps at pickup
 * too, so the api mirrors that posture instead of arguing with the owner).
 */
export interface UpdateSettingsRequest {
  downloadConcurrency?: number;
  qualityCap?: QualityCap;
  subtitleMode?: SubtitleMode;
}

/** Per-channel storage footprint (CR-01). `usedBytes` = Σ `Video.sizeBytes`. */
export interface StorageChannelUsage {
  channelId: string;
  channelTitle: string;
  usedBytes: number;
  videoCount: number;
}

/**
 * `GET /api/storage` response (CR-01, read-only). `vault` is the live figure
 * from `statfs(vaultRoot)` (used = total − free, so it always sums); `channels`
 * is the DB `SUM(sizeBytes)` per channel (nulls ignored). BigInt byte counts
 * cross the JSON boundary as `number` (the mapper convention). Limits and
 * auto-pause are deliberately out of scope.
 */
export interface StorageStatsResponse {
  vault: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
  };
  channels: StorageChannelUsage[];
}
