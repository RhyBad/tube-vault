/**
 * settings-presentation — the pure logic behind S9's three independent backends,
 * kept free of React so the merge rules, the concurrency clamp, and the
 * credential state machine are tested deterministically. The components/hooks
 * stay thin: fetch + wire, delegating every decision here.
 */
import {
  NOTIFICATION_EVENT_TYPES,
  SECRET_CONFIG_KEYS,
  type NotificationChannelType,
  type SessionStatusResponse,
  type SettingsDto,
  type TestNotificationChannelResponse,
} from '@tubevault/types';

import type { SecretChange } from '../../ds';

/** The load lifecycle each independent section drives its shell with (spec §6). */
export type SectionPhase = 'loading' | 'error' | 'ready';

// ---- Notification-channel config descriptors ------------------------------

/** Every config key across the five types (the union that types the i18n labels). */
export type ConfigKey =
  'botToken' | 'chatId' | 'webhookUrl' | 'serverUrl' | 'appToken' | 'topic' | 'accessToken' | 'url';

/** A single config input the add/edit forms render, in display order. */
export interface ConfigField {
  key: ConfigKey;
  secret: boolean;
  optional: boolean;
  /** §S9-6: a format-example placeholder for plain fields (URLs, id shapes). These
   *  are technical format hints, not prose — kept as literals (not localized). */
  placeholder?: string;
}

/**
 * Format-example placeholders for the PLAIN (non-secret) config keys only —
 * secret keys render via MaskedSecretInput, which ignores `placeholder`. So this
 * map covers chatId/serverUrl/topic; webhookUrl (DISCORD) and url (WEBHOOK) are
 * secret keys and get no entry. `serverUrl` is shared by GOTIFY + NTFY, so its
 * example host stays product-neutral.
 */
const CONFIG_PLACEHOLDERS: Partial<Record<ConfigKey, string>> = {
  chatId: '-100123456789',
  serverUrl: 'https://push.example.com',
  topic: 'tubevault-alerts',
};

/**
 * The ordered config keys per type (matches the manifest's per-type CONFIG_SCHEMAS).
 * `secret` is NOT declared here — it is derived from the types-package
 * SECRET_CONFIG_KEYS so the two sides can never disagree on what is secret.
 */
const CONFIG_KEYS: Readonly<
  Record<NotificationChannelType, ReadonlyArray<{ key: ConfigKey; optional?: boolean }>>
> = {
  TELEGRAM: [{ key: 'botToken' }, { key: 'chatId' }],
  DISCORD: [{ key: 'webhookUrl' }],
  GOTIFY: [{ key: 'serverUrl' }, { key: 'appToken' }],
  NTFY: [{ key: 'serverUrl' }, { key: 'topic' }, { key: 'accessToken', optional: true }],
  WEBHOOK: [{ key: 'url' }],
};

/** The form's field list for a type — secret flags sourced from SECRET_CONFIG_KEYS. */
export function configFields(type: NotificationChannelType): ConfigField[] {
  const secretKeys = SECRET_CONFIG_KEYS[type];
  return CONFIG_KEYS[type].map((f) => ({
    key: f.key,
    secret: secretKeys.includes(f.key),
    optional: f.optional ?? false,
    placeholder: CONFIG_PLACEHOLDERS[f.key],
  }));
}

/**
 * The outcome of assembling a `config` object for POST (create) / PATCH (edit).
 * `invalid` lists the field keys that failed client-side validation (rendered
 * red before any round-trip), mirroring the server's per-type 400.
 */
export interface ConfigBuildResult {
  config: Record<string, string>;
  invalid: string[];
}

/**
 * Build the `config` body for a create OR an edit — the difference is only which
 * secret fields already have a stored value (`storedSecretKeys`; empty for create).
 * Merge rules (manifest §424, mirrored client-side):
 *  - plain field: trimmed value; empty + required → invalid.
 *  - secret 'set'    → replace with the typed value (trimmed).
 *  - secret 'delete' → send '' (delete); flagged invalid if the field is required.
 *  - secret 'keep' / untouched-with-stored-value → OMIT (server keeps it).
 *  - secret 'empty'  / untouched-without-stored-value → missing; invalid if required.
 * An untouched secret field (no SecretChange) defaults to keep when a value is
 * already stored, else empty — matching MaskedSecretInput's own derivation.
 */
export function buildConfig(
  type: NotificationChannelType,
  plain: Readonly<Record<string, string>>,
  secrets: Readonly<Record<string, SecretChange | undefined>>,
  storedSecretKeys: ReadonlySet<string>,
): ConfigBuildResult {
  const config: Record<string, string> = {};
  const invalid: string[] = [];

  for (const field of configFields(type)) {
    if (field.secret) {
      const change = secrets[field.key];
      const action = change?.action ?? (storedSecretKeys.has(field.key) ? 'keep' : 'empty');
      if (action === 'set') {
        config[field.key] = (change?.value ?? '').trim();
      } else if (action === 'delete') {
        if (field.optional) config[field.key] = '';
        else invalid.push(field.key);
      } else if (action === 'empty') {
        // No value entered and none stored — missing. Fine only if optional.
        if (!field.optional) invalid.push(field.key);
      }
      // 'keep' → omit (the server keeps the stored secret).
    } else {
      const value = (plain[field.key] ?? '').trim();
      if (value === '') {
        if (!field.optional) invalid.push(field.key);
      } else {
        config[field.key] = value;
      }
    }
  }

  return { config, invalid };
}

// ---- Global defaults (clamp + diff) ---------------------------------------

/** The changed fields only — EP-08 is a partial (strict) update. */
export function settingsPatchDiff(draft: SettingsDto, data: SettingsDto): Partial<SettingsDto> {
  const patch: Partial<SettingsDto> = {};
  if (draft.downloadConcurrency !== data.downloadConcurrency) {
    patch.downloadConcurrency = draft.downloadConcurrency;
  }
  if (draft.qualityCap !== data.qualityCap) patch.qualityCap = draft.qualityCap;
  if (draft.subtitleMode !== data.subtitleMode) patch.subtitleMode = draft.subtitleMode;
  return patch;
}

/** True when the draft differs from the saved data (drives the Save button). */
export function isSettingsDirty(draft: SettingsDto, data: SettingsDto): boolean {
  return Object.keys(settingsPatchDiff(draft, data)).length > 0;
}

/**
 * The server clamps downloadConcurrency to [1,4]. After a save, if the returned
 * value differs from what we sent, return the clamped value (to sync the UI and
 * explain the adjustment); else null. Detected from the RESPONSE, never guessed.
 */
export function clampNotice(sent: Partial<SettingsDto>, res: SettingsDto): number | null {
  if (
    sent.downloadConcurrency !== undefined &&
    sent.downloadConcurrency !== res.downloadConcurrency
  ) {
    return res.downloadConcurrency;
  }
  return null;
}

// ---- YouTube credential state machine -------------------------------------

export type BadgeIntent = 'success' | 'progress' | 'danger' | 'muted';

/** Everything the credential section needs to render — derived from EP-04. */
export interface CredentialView {
  /** Feature off (TUBEVAULT_CREDENTIAL_KEY_FILE unset) → 503 banner, import disabled. */
  disabled: boolean;
  /** A credential row exists → the delete button shows. */
  configured: boolean;
  status: SessionStatusResponse['status'];
  showBadge: boolean;
  badgeIntent: BadgeIntent;
  /** EXPIRED → warning + the S7 Live cross-link. */
  expired: boolean;
  /** UNVERIFIED → the calm "a worker will verify shortly" note. */
  unverified: boolean;
  lastVerifiedAt: string | null;
  failureStreak: number;
  streakIntent: 'muted' | 'danger';
  lastError: string | null;
}

const STATUS_INTENT: Record<NonNullable<SessionStatusResponse['status']>, BadgeIntent> = {
  VERIFIED: 'success',
  UNVERIFIED: 'progress',
  EXPIRED: 'danger',
};

export function deriveCredentialView(s: SessionStatusResponse): CredentialView {
  const disabled = !s.enabled;
  return {
    disabled,
    configured: s.configured,
    status: s.status,
    showBadge: !disabled && s.status !== null,
    badgeIntent: s.status !== null ? STATUS_INTENT[s.status] : 'muted',
    expired: s.status === 'EXPIRED',
    unverified: s.status === 'UNVERIFIED',
    lastVerifiedAt: s.lastVerifiedAt,
    failureStreak: s.failureStreak,
    streakIntent: s.failureStreak > 0 ? 'danger' : 'muted',
    lastError: s.lastError,
  };
}

// ---- Test-send result + events summary ------------------------------------

export interface TestResultView {
  ok: boolean;
  intent: 'success' | 'warning';
  titleKey: 'delivered' | 'notDelivered';
  /** Secret-free description from the server (e.g. "HTTP 401", "timed out …"). */
  detail: string;
}

/**
 * A test send's outcome. A failed delivery is a NEUTRAL result (warning, not an
 * error) — the send itself succeeded as an HTTP call and the detail is shown.
 */
export function testResultView(res: TestNotificationChannelResponse): TestResultView {
  return {
    ok: res.delivered,
    intent: res.delivered ? 'success' : 'warning',
    titleKey: res.delivered ? 'delivered' : 'notDelivered',
    detail: res.detail,
  };
}

/** The edit form's events summary: whether all types are selected + the count. */
export function eventsSummary(events: readonly string[]): { all: boolean; count: number } {
  return { all: events.length === NOTIFICATION_EVENT_TYPES.length, count: events.length };
}
