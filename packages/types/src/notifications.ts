/**
 * Session + notification transport types (P8). Browser-safe: no runtime deps,
 * Dates as ISO strings; the api's DTO mappers are the only Prisma boundary.
 */

// ---------------------------------------------------------------------------
// Owner YouTube session (Credential row surface — NOT the dashboard login).
// ---------------------------------------------------------------------------

/**
 * Lifecycle of the stored owner session (mirror of the Prisma SessionStatus
 * enum). NOTE the rename: v1 called the verified state ACTIVE; the v2 schema
 * (and everything downstream) says VERIFIED — same meaning, schema name wins.
 */
export type SessionStatus = 'UNVERIFIED' | 'VERIFIED' | 'EXPIRED';

/** `PUT /api/session` body: the freshly-exported Netscape cookie jar text. */
export interface ImportSessionRequest {
  cookies: string;
}

/**
 * `GET/PUT/DELETE /api/session` response. `enabled` = the api has a credential
 * key file (TUBEVAULT_CREDENTIAL_KEY_FILE) — without it the whole session
 * feature is off; `configured` = a credential row exists. The cookie material
 * itself NEVER appears in any response.
 */
export interface SessionStatusResponse {
  enabled: boolean;
  configured: boolean;
  status: SessionStatus | null;
  lastVerifiedAt: string | null;
  failureStreak: number;
  lastError: string | null;
}

// ---------------------------------------------------------------------------
// Notification event taxonomy (v1 domain/events.py dotted wire values).
// ---------------------------------------------------------------------------

/**
 * The v1 event types + CR-09's `source.gone`. Not every one is emitted yet:
 *  - emitted today: download.failed, youtube.bot_wall (P6a), session.expired,
 *    system.test (P8), live.start / live.stop (P10), and source.gone /
 *    video.rescued (CR-09 source re-check)
 *  - reserved for later phases: storage.near_full / storage.paused /
 *    worker.stalled (kept in the taxonomy so channel event-toggles stay stable).
 */
export const NOTIFICATION_EVENT_TYPES = [
  'download.failed',
  'storage.near_full',
  'storage.paused',
  'source.gone',
  'video.rescued',
  'live.start',
  'live.stop',
  'session.expired',
  'system.test',
  'worker.stalled',
  'youtube.bot_wall',
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

/** Type guard for the dotted taxonomy (drives the channels CRUD 400 on strangers). */
export function isNotificationEventType(value: string): value is NotificationEventType {
  return (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Severity (mirror of the Prisma Severity enum, with v1's explicit ordering).
// ---------------------------------------------------------------------------

export type NotificationSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

/** The three levels in RANK ORDER (v1 _SEVERITY_RANK). */
export const NOTIFICATION_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;

const SEVERITY_RANK: Readonly<Record<NotificationSeverity, number>> = {
  INFO: 0,
  WARNING: 1,
  CRITICAL: 2,
};

/** True if `severity` >= `threshold` (inclusive) — v1 `Severity.at_least`. */
export function severityAtLeast(
  severity: NotificationSeverity,
  threshold: NotificationSeverity,
): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[threshold];
}

// ---------------------------------------------------------------------------
// The wire event (v1 NotificationEvent): what the notify senders serialize.
// ---------------------------------------------------------------------------

/**
 * One notifiable event, ready for delivery. `type` is the dotted taxonomy
 * (kept an open string to match the Notification row's column — the taxonomy
 * const above is the validation source of truth). `data` carries small
 * pre-stringified extras for adapters (v1 parity).
 */
export interface NotifyEvent {
  type: string;
  severity: NotificationSeverity;
  /** ISO-8601 timestamp. */
  at: string;
  title: string;
  body: string;
  channelId?: string;
  videoId?: string;
  dedupeKey?: string;
  data?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Notification channel CRUD DTOs.
// ---------------------------------------------------------------------------

/** Delivery-target kinds (mirror of the Prisma NotificationChannelType enum).
 * NOTE: v1 also had SMTP; it is deliberately out of the v2 core-first scope
 * (not in the schema enum nor PLAN.md's P8 sender list). */
export type NotificationChannelType = 'TELEGRAM' | 'DISCORD' | 'GOTIFY' | 'NTFY' | 'WEBHOOK';

/** Runtime mirror (zod enums / UI selects derive from it). */
export const NOTIFICATION_CHANNEL_TYPES = [
  'TELEGRAM',
  'DISCORD',
  'GOTIFY',
  'NTFY',
  'WEBHOOK',
] as const satisfies readonly NotificationChannelType[];

/** Telegram bot: the token is the secret (it lives in the API URL path). */
export interface TelegramChannelConfig {
  botToken: string;
  chatId: string;
}

/** Discord incoming webhook: the URL embeds its token — the whole URL is secret. */
export interface DiscordChannelConfig {
  webhookUrl: string;
}

export interface GotifyChannelConfig {
  serverUrl: string;
  /** Secret — sent as the X-Gotify-Key header, never in the URL. */
  appToken: string;
}

export interface NtfyChannelConfig {
  serverUrl: string;
  topic: string;
  /** Optional Bearer token for a private server (secret). */
  accessToken?: string;
}

/** Generic webhook: the URL may embed a secret token — treated as secret. */
export interface WebhookChannelConfig {
  url: string;
}

/** Per-type config shapes, keyed for the discriminated request union below. */
export interface NotificationChannelConfigByType {
  TELEGRAM: TelegramChannelConfig;
  DISCORD: DiscordChannelConfig;
  GOTIFY: GotifyChannelConfig;
  NTFY: NtfyChannelConfig;
  WEBHOOK: WebhookChannelConfig;
}

/**
 * `POST /api/notification-channels` body — discriminated on `type` so the
 * config shape is checked per target. `events` omitted = ALL event types
 * (v1 ALL_EVENT_TYPES opt-out default).
 */
export type CreateNotificationChannelRequest = {
  [T in NotificationChannelType]: {
    type: T;
    name: string;
    config: NotificationChannelConfigByType[T];
    events?: NotificationEventType[];
    minSeverity?: NotificationSeverity;
    enabled?: boolean;
  };
}[NotificationChannelType];

/**
 * `PATCH /api/notification-channels/:id` body. `type` is immutable (a type
 * change would orphan the config — delete + recreate instead). Keep-secret
 * semantics: a secret config field that is OMITTED or set to the literal
 * SECRET_MASK keeps the stored value; the merged config is re-validated.
 */
export interface UpdateNotificationChannelRequest {
  name?: string;
  config?: Record<string, string>;
  events?: NotificationEventType[];
  minSeverity?: NotificationSeverity;
  enabled?: boolean;
}

/**
 * The FULL mask secret config fields are read back as (chosen over a
 * last-4-chars partial mask: simplest, zero partial leak). Also the PATCH
 * "keep the stored secret" sentinel, so a client can round-trip a GET
 * response into a PATCH body unchanged.
 */
export const SECRET_MASK = '***';

/**
 * Which config keys hold secrets, per type (v1 secret_config_keys, camelCase).
 * Shared by the api (DTO masking + keep-secret PATCH + redaction registration)
 * AND the worker (registering secrets before each external dispatch — v1
 * defense-in-depth parity), so the two sides can never disagree on what is
 * secret.
 */
export const SECRET_CONFIG_KEYS: Readonly<Record<NotificationChannelType, readonly string[]>> = {
  TELEGRAM: ['botToken'],
  DISCORD: ['webhookUrl'], // the URL embeds its token — the whole URL is the secret
  GOTIFY: ['appToken'],
  NTFY: ['accessToken'],
  WEBHOOK: ['url'], // may embed a secret token — treated as secret like v1
};

/** A delivery target as the api returns it — secret config fields are ALWAYS
 * masked to SECRET_MASK (plaintext secrets never leave the api). */
export interface NotificationChannelDto {
  id: string;
  type: NotificationChannelType;
  name: string;
  config: Record<string, string>;
  events: string[];
  minSeverity: NotificationSeverity;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/notification-channels` response. */
export interface NotificationChannelListResponse {
  channels: NotificationChannelDto[];
}

/** `POST /api/notification-channels/:id/test` response (send outcome, secret-free). */
export interface TestNotificationChannelResponse {
  delivered: boolean;
  detail: string;
}

// ---------------------------------------------------------------------------
// In-app notification center (read side; rows exist since P6a).
// ---------------------------------------------------------------------------

export interface NotificationDto {
  id: string;
  type: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  channelId: string | null;
  videoId: string | null;
  dedupeKey: string | null;
  createdAt: string;
  dismissedAt: string | null;
}

/** `GET /api/notifications` response: newest first, keyset-paged (null = last page). */
export interface NotificationListResponse {
  notifications: NotificationDto[];
  nextCursor: string | null;
}

/** `POST /api/notifications/:id/dismiss` response (idempotent: re-dismiss returns the row). */
export interface DismissNotificationResponse {
  notification: NotificationDto;
}

/**
 * `POST /api/notifications/dismiss-all` response — the "mark all read" verb.
 * `dismissed` = how many rows this call NEWLY dismissed (already-dismissed rows
 * are untouched, so a repeat call reports 0). Never deletes rows. (CR-28.)
 */
export interface DismissAllNotificationsResponse {
  dismissed: number;
}

/**
 * Why a single id in a bulk dismiss (EP-42) could not be dismissed. The ONLY
 * failure mode is a missing row — dismiss has no active-job/conflict concept
 * (unlike the queue-bulk verb's richer taxonomy). (CR-28.)
 */
export type NotificationDismissFailureReason = 'not_found';

/** Runtime mirror of the reason union (parity with the queue-bulk taxonomy). */
export const NOTIFICATION_DISMISS_FAILURE_REASONS = [
  'not_found',
] as const satisfies readonly NotificationDismissFailureReason[];

/**
 * `POST /api/notifications/dismiss` body — an explicit, bounded id batch. Only
 * EXPLICIT ids (no server-side filter-dismiss: a bulk verb must not widen its
 * own blast radius; the UI resolves a filtered selection to ids). (CR-28.)
 */
export interface BulkDismissNotificationsRequest {
  ids: string[];
}

/**
 * `POST /api/notifications/dismiss` response — per-id verdict, ALWAYS 200
 * (mirrors the queue-bulk envelope, EP-25). `dismissed` = count NEWLY dismissed
 * (an existing already-dismissed id is an idempotent no-op: neither counted nor
 * failed); `failed` carries the not-found ids. (CR-28.)
 */
export interface BulkDismissNotificationsResponse {
  dismissed: number;
  failed: { id: string; reason: NotificationDismissFailureReason }[];
}
