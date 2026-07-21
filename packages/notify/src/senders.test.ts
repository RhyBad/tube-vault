/**
 * Pure payload builders — the v1 adapter HTTP contracts pinned EXACTLY
 * (notifier_telegram/discord/gotify/ntfy/webhook.py): URL construction,
 * payload shapes, severity → color/priority/tags maps, lowercase wire
 * severities. These snapshots ARE the contract the P8 senders speak.
 */
import type { NotifyEvent } from '@tubevault/types';
import { describe, expect, it } from 'vitest';

import {
  DISCORD_SEVERITY_COLOR,
  GOTIFY_SEVERITY_PRIORITY,
  NTFY_SEVERITY_PRIORITY,
  NTFY_SEVERITY_TAGS,
  discordPayload,
  gotifyMessageUrl,
  gotifyPayload,
  ntfyPayload,
  telegramApiUrl,
  telegramPayload,
  telegramText,
  webhookPayload,
} from './senders.js';

const FULL: NotifyEvent = {
  type: 'download.failed',
  severity: 'WARNING',
  at: '2026-07-02T03:04:05.000Z',
  title: 'Download failed: Some Video',
  body: 'yt-dlp exited with 1',
  channelId: 'UCchan000000000000000000',
  videoId: 'vid00000042',
  dedupeKey: 'download.failed:vid00000042:3',
  data: { attempt: '5' },
};

const BARE: NotifyEvent = {
  type: 'system.test',
  severity: 'INFO',
  at: '2026-07-02T03:04:05.000Z',
  title: 'TubeVault test notification',
  body: '',
};

describe('telegram (v1 notifier_telegram.py)', () => {
  it('builds the bot-token URL (token in the PATH — the API design)', () => {
    expect(telegramApiUrl('123:abc')).toBe('https://api.telegram.org/bot123:abc/sendMessage');
  });

  it('plain text: title, body, blank line, [severity] type · video id footer', () => {
    expect(telegramText(FULL)).toBe(
      'Download failed: Some Video\nyt-dlp exited with 1\n\n[warning] download.failed · video vid00000042',
    );
  });

  it('bodyless + videoless event: no body line, no video suffix', () => {
    expect(telegramText(BARE)).toBe('TubeVault test notification\n\n[info] system.test');
  });

  it('payload is {chat_id, text} — no parse_mode (no escaping needed)', () => {
    expect(telegramPayload(FULL, '-100200300')).toEqual({
      chat_id: '-100200300',
      text: telegramText(FULL),
    });
  });
});

describe('discord (v1 notifier_discord.py)', () => {
  it('pins the severity color map (decimal RGB)', () => {
    expect(DISCORD_SEVERITY_COLOR).toEqual({
      INFO: 0x3498db,
      WARNING: 0xe67e22,
      CRITICAL: 0xe74c3c,
    });
  });

  it('a single embed: title/color/timestamp/description/inline data fields/footer', () => {
    expect(discordPayload(FULL)).toEqual({
      embeds: [
        {
          title: 'Download failed: Some Video',
          color: 0xe67e22,
          timestamp: '2026-07-02T03:04:05.000Z',
          description: 'yt-dlp exited with 1',
          fields: [{ name: 'attempt', value: '5', inline: true }],
          footer: { text: 'download.failed · warning · video vid00000042' },
        },
      ],
    });
  });

  it('sparse embed: no description/fields when body/data are empty, footer without video', () => {
    expect(discordPayload(BARE)).toEqual({
      embeds: [
        {
          title: 'TubeVault test notification',
          color: 0x3498db,
          timestamp: '2026-07-02T03:04:05.000Z',
          footer: { text: 'system.test · info' },
        },
      ],
    });
  });
});

describe('gotify (v1 notifier_gotify.py)', () => {
  it('pins the priority map (0..10 scale: 2/5/8)', () => {
    expect(GOTIFY_SEVERITY_PRIORITY).toEqual({ INFO: 2, WARNING: 5, CRITICAL: 8 });
  });

  it('POSTs to {serverUrl}/message (trailing slashes stripped)', () => {
    expect(gotifyMessageUrl('https://gotify.example.com')).toBe(
      'https://gotify.example.com/message',
    );
    expect(gotifyMessageUrl('https://gotify.example.com//')).toBe(
      'https://gotify.example.com/message',
    );
  });

  it('payload {title, message, priority}; empty body falls back to the title', () => {
    expect(gotifyPayload(FULL)).toEqual({
      title: 'Download failed: Some Video',
      message: 'yt-dlp exited with 1',
      priority: 5,
    });
    expect(gotifyPayload(BARE)).toEqual({
      title: 'TubeVault test notification',
      message: 'TubeVault test notification',
      priority: 2,
    });
  });
});

describe('ntfy (v1 notifier_ntfy.py)', () => {
  it('pins the priority (3/4/5) and emoji-tag maps', () => {
    expect(NTFY_SEVERITY_PRIORITY).toEqual({ INFO: 3, WARNING: 4, CRITICAL: 5 });
    expect(NTFY_SEVERITY_TAGS).toEqual({
      INFO: ['information_source'],
      WARNING: ['warning'],
      CRITICAL: ['rotating_light'],
    });
  });

  it('payload {topic, title, message, priority, tags}; empty body falls back to title', () => {
    expect(ntfyPayload(FULL, 'tubevault-alerts')).toEqual({
      topic: 'tubevault-alerts',
      title: 'Download failed: Some Video',
      message: 'yt-dlp exited with 1',
      priority: 4,
      tags: ['warning'],
    });
    expect(ntfyPayload(BARE, 't')).toMatchObject({
      message: 'TubeVault test notification',
      priority: 3,
      tags: ['information_source'],
    });
  });
});

describe('webhook (v1 notifier_webhook.py / notification_event_to_dict)', () => {
  it('canonical event JSON — camelCase keys (v2 deviation from v1 snake_case), lowercase severity, sparse optionals', () => {
    expect(webhookPayload(FULL)).toEqual({
      type: 'download.failed',
      severity: 'warning',
      at: '2026-07-02T03:04:05.000Z',
      title: 'Download failed: Some Video',
      body: 'yt-dlp exited with 1',
      channelId: 'UCchan000000000000000000',
      videoId: 'vid00000042',
      dedupeKey: 'download.failed:vid00000042:3',
      data: { attempt: '5' },
    });
  });

  it('unset optionals (and empty data) are OMITTED, body always present', () => {
    expect(webhookPayload(BARE)).toEqual({
      type: 'system.test',
      severity: 'info',
      at: '2026-07-02T03:04:05.000Z',
      title: 'TubeVault test notification',
      body: '',
    });
    expect(webhookPayload({ ...BARE, data: {} })).not.toHaveProperty('data');
  });
});
