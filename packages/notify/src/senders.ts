/**
 * PURE per-target payload builders — the v1 adapter HTTP contracts ported
 * EXACTLY (src/tubevault/adapters/notifier_{telegram,discord,gotify,ntfy,
 * webhook}.py): URL construction, payload shapes, the severity → color /
 * priority / tags maps, lowercase wire severities. No I/O here; send.ts does
 * the POSTing.
 */
import type { NotificationSeverity, NotifyEvent } from '@tubevault/types';

/** v1 wire severities are lowercase (`Severity.value`); the row enum is upper. */
function wireSeverity(severity: NotificationSeverity): string {
  return severity.toLowerCase();
}

// ---------------------------------------------------------------------------
// Telegram (v1 notifier_telegram.py)
// ---------------------------------------------------------------------------

/** The bot token lives in the URL *path* (the Bot API design) — it IS the secret. */
export function telegramApiUrl(botToken: string): string {
  return `https://api.telegram.org/bot${botToken}/sendMessage`;
}

/** Plain text (no parse_mode, so title/body need no HTML/Markdown escaping). */
export function telegramText(event: NotifyEvent): string {
  const lines = [event.title];
  if (event.body) {
    lines.push(event.body);
  }
  let footer = `[${wireSeverity(event.severity)}] ${event.type}`;
  if (event.videoId) {
    footer += ` · video ${event.videoId}`;
  }
  lines.push('', footer);
  return lines.join('\n');
}

export function telegramPayload(event: NotifyEvent, chatId: string): Record<string, unknown> {
  return { chat_id: chatId, text: telegramText(event) };
}

// ---------------------------------------------------------------------------
// Discord (v1 notifier_discord.py)
// ---------------------------------------------------------------------------

/** Discord embed accent color per severity (decimal RGB, v1 _SEVERITY_COLOR). */
export const DISCORD_SEVERITY_COLOR: Readonly<Record<NotificationSeverity, number>> = {
  INFO: 0x3498db, // blue
  WARNING: 0xe67e22, // orange
  CRITICAL: 0xe74c3c, // red
};

/** A single embed: title/color/timestamp, sparse description/fields, footer. */
export function discordPayload(event: NotifyEvent): Record<string, unknown> {
  const embed: Record<string, unknown> = {
    title: event.title,
    color: DISCORD_SEVERITY_COLOR[event.severity],
    // ACCEPTED cosmetic deviation: event.at is JS toISOString() ('…Z') where
    // v1 sent Python isoformat ('…+00:00'). Both are valid ISO-8601 UTC and
    // Discord accepts either — same instant, different spelling.
    timestamp: event.at,
  };
  if (event.body) {
    embed['description'] = event.body;
  }
  const fields = Object.entries(event.data ?? {}).map(([name, value]) => ({
    name,
    value,
    inline: true,
  }));
  if (fields.length > 0) {
    embed['fields'] = fields;
  }
  const footerBits = [`${event.type} · ${wireSeverity(event.severity)}`];
  if (event.videoId) {
    footerBits.push(`video ${event.videoId}`);
  }
  embed['footer'] = { text: footerBits.join(' · ') };
  return { embeds: [embed] };
}

// ---------------------------------------------------------------------------
// Gotify (v1 notifier_gotify.py)
// ---------------------------------------------------------------------------

/** Gotify priority is 0…10 (higher = more intrusive); severity spans the range. */
export const GOTIFY_SEVERITY_PRIORITY: Readonly<Record<NotificationSeverity, number>> = {
  INFO: 2,
  WARNING: 5,
  CRITICAL: 8,
};

/** POST target: `{serverUrl}/message` (the token goes in X-Gotify-Key, never the URL). */
export function gotifyMessageUrl(serverUrl: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/message`;
}

export function gotifyPayload(event: NotifyEvent): Record<string, unknown> {
  return {
    title: event.title,
    message: event.body || event.title,
    priority: GOTIFY_SEVERITY_PRIORITY[event.severity],
  };
}

// ---------------------------------------------------------------------------
// ntfy (v1 notifier_ntfy.py)
// ---------------------------------------------------------------------------

/** ntfy priority is 1 (min) … 5 (max), default 3; severity maps onto the top half. */
export const NTFY_SEVERITY_PRIORITY: Readonly<Record<NotificationSeverity, number>> = {
  INFO: 3,
  WARNING: 4,
  CRITICAL: 5,
};

/** A leading emoji tag per severity (ntfy renders these as icons). */
export const NTFY_SEVERITY_TAGS: Readonly<Record<NotificationSeverity, string[]>> = {
  INFO: ['information_source'],
  WARNING: ['warning'],
  CRITICAL: ['rotating_light'],
};

/** ntfy JSON publish API: POST to the server ROOT with `topic` in the body. */
export function ntfyPayload(event: NotifyEvent, topic: string): Record<string, unknown> {
  return {
    topic,
    title: event.title,
    message: event.body || event.title,
    priority: NTFY_SEVERITY_PRIORITY[event.severity],
    tags: NTFY_SEVERITY_TAGS[event.severity],
  };
}

// ---------------------------------------------------------------------------
// Generic webhook (v1 notifier_webhook.py + notification_event_to_dict)
// ---------------------------------------------------------------------------

/**
 * The canonical event serialization, sparse (unset optionals omitted, empty
 * data omitted; body always present) with the v1 lowercase wire severity.
 * DELIBERATE v1 DEVIATION: keys are camelCase (channelId/videoId/dedupeKey)
 * where v1 sent snake_case — v2's whole wire surface is camelCase and this is
 * a fresh-start cutover (PLAN.md owner decision 3), so no consumer contract is
 * broken by aligning it. The SAME rename applies to the channel CONFIG keys
 * (v1 bot_token/app_token/access_token/webhook_url/server_url → botToken/
 * appToken/accessToken/webhookUrl/serverUrl): stored configs are new-in-v2
 * rows, so nothing migrates.
 */
export function webhookPayload(event: NotifyEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: event.type,
    severity: wireSeverity(event.severity),
    at: event.at,
    title: event.title,
    body: event.body,
  };
  if (event.channelId !== undefined) {
    out['channelId'] = event.channelId;
  }
  if (event.videoId !== undefined) {
    out['videoId'] = event.videoId;
  }
  if (event.dedupeKey !== undefined) {
    out['dedupeKey'] = event.dedupeKey;
  }
  if (event.data !== undefined && Object.keys(event.data).length > 0) {
    out['data'] = event.data;
  }
  return out;
}
