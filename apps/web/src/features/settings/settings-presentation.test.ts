/**
 * settings-presentation spec (S9 P2) — the pure logic behind the three backends,
 * kept React-free so the merge rules, the concurrency clamp, and the credential
 * state machine are tested deterministically. The components/hooks stay thin.
 */
import { describe, expect, it } from 'vitest';

import { SECRET_CONFIG_KEYS, type SessionStatusResponse, type SettingsDto } from '@tubevault/types';

import type { SecretChange } from '../../ds';
import {
  buildConfig,
  clampNotice,
  configFields,
  deriveCredentialView,
  eventsSummary,
  settingsPatchDiff,
  testResultView,
} from './settings-presentation';

const set = (value: string): SecretChange => ({ value, action: 'set' });
const del: SecretChange = { value: '', action: 'delete' };
const keep: SecretChange = { value: '', action: 'keep' };
const empty: SecretChange = { value: '', action: 'empty' };

describe('configFields — per-type descriptors', () => {
  it('orders TELEGRAM fields with the secret flag from SECRET_CONFIG_KEYS', () => {
    expect(configFields('TELEGRAM')).toEqual([
      { key: 'botToken', secret: true, optional: false },
      { key: 'chatId', secret: false, optional: false, placeholder: '-100123456789' },
    ]);
  });

  it('marks NTFY accessToken secret AND optional', () => {
    const ntfy = configFields('NTFY');
    expect(ntfy.map((f) => f.key)).toEqual(['serverUrl', 'topic', 'accessToken']);
    expect(ntfy.find((f) => f.key === 'accessToken')).toEqual({
      key: 'accessToken',
      secret: true,
      optional: true,
    });
  });

  it('the secret flags agree with the types-package SECRET_CONFIG_KEYS for every type', () => {
    (['TELEGRAM', 'DISCORD', 'GOTIFY', 'NTFY', 'WEBHOOK'] as const).forEach((type) => {
      const declaredSecrets = configFields(type)
        .filter((f) => f.secret)
        .map((f) => f.key)
        .sort();
      expect(declaredSecrets).toEqual([...SECRET_CONFIG_KEYS[type]].sort());
    });
  });
});

describe('buildConfig — create (no stored secrets)', () => {
  const stored = new Set<string>();

  it('includes trimmed plain + set-secret values', () => {
    const { config, invalid } = buildConfig(
      'TELEGRAM',
      { chatId: '  -100123  ' },
      { botToken: set(' 12:AbC ') },
      stored,
    );
    expect(invalid).toEqual([]);
    expect(config).toEqual({ botToken: '12:AbC', chatId: '-100123' });
  });

  it('flags a missing required secret and a missing required plain field', () => {
    const { config, invalid } = buildConfig(
      'TELEGRAM',
      { chatId: '' },
      { botToken: empty },
      stored,
    );
    expect(config).toEqual({});
    expect(invalid.sort()).toEqual(['botToken', 'chatId']);
  });

  it('omits an untouched optional secret (NTFY accessToken) without flagging it', () => {
    const { config, invalid } = buildConfig(
      'NTFY',
      { serverUrl: 'https://ntfy.sh', topic: 't' },
      {},
      stored,
    );
    expect(invalid).toEqual([]);
    expect(config).toEqual({ serverUrl: 'https://ntfy.sh', topic: 't' });
  });
});

describe('buildConfig — edit (stored secrets, keep/delete/replace merge)', () => {
  it('omits an untouched stored secret so the server keeps it', () => {
    const { config, invalid } = buildConfig(
      'TELEGRAM',
      { chatId: '-100' },
      {}, // botToken untouched
      new Set(['botToken']),
    );
    expect(invalid).toEqual([]);
    expect(config).toEqual({ chatId: '-100' }); // no botToken → keep stored
  });

  it('replaces a secret when a new value is typed', () => {
    const { config } = buildConfig(
      'DISCORD',
      {},
      { webhookUrl: set('https://discord/new') },
      new Set(['webhookUrl']),
    );
    expect(config).toEqual({ webhookUrl: 'https://discord/new' });
  });

  it('sends "" to delete an OPTIONAL secret, but flags deleting a REQUIRED one', () => {
    const optional = buildConfig(
      'NTFY',
      { serverUrl: 'https://ntfy.sh', topic: 't' },
      { accessToken: del },
      new Set(['accessToken']),
    );
    expect(optional.invalid).toEqual([]);
    expect(optional.config.accessToken).toBe('');

    const required = buildConfig('WEBHOOK', {}, { url: del }, new Set(['url']));
    expect(required.invalid).toEqual(['url']);
  });

  it('treats an explicit keep like an untouched field (omit)', () => {
    const { config } = buildConfig(
      'GOTIFY',
      { serverUrl: 'https://g' },
      { appToken: keep },
      new Set(['appToken']),
    );
    expect(config).toEqual({ serverUrl: 'https://g' });
  });
});

describe('settingsPatchDiff / clampNotice — global defaults', () => {
  const data: SettingsDto = {
    downloadConcurrency: 1,
    qualityCap: 'UNLIMITED',
    subtitleMode: 'BOTH',
  };

  it('emits only the changed fields', () => {
    expect(settingsPatchDiff({ ...data, qualityCap: 'P1080' }, data)).toEqual({
      qualityCap: 'P1080',
    });
    expect(settingsPatchDiff(data, data)).toEqual({});
    expect(
      settingsPatchDiff({ downloadConcurrency: 3, qualityCap: 'P720', subtitleMode: 'NONE' }, data),
    ).toEqual({ downloadConcurrency: 3, qualityCap: 'P720', subtitleMode: 'NONE' });
  });

  it('reports the clamped value only when the server changed what was sent', () => {
    expect(clampNotice({ downloadConcurrency: 5 }, { ...data, downloadConcurrency: 4 })).toBe(4);
    expect(clampNotice({ downloadConcurrency: 3 }, { ...data, downloadConcurrency: 3 })).toBeNull();
    expect(clampNotice({ qualityCap: 'P720' }, { ...data, qualityCap: 'P720' })).toBeNull();
  });
});

describe('deriveCredentialView — the credential state machine', () => {
  const base: SessionStatusResponse = {
    enabled: true,
    configured: true,
    status: 'VERIFIED',
    lastVerifiedAt: '2026-07-15T00:00:00.000Z',
    failureStreak: 0,
    lastError: null,
  };

  it('VERIFIED → success badge, no banners, delete shown', () => {
    const v = deriveCredentialView(base);
    expect(v).toMatchObject({
      disabled: false,
      configured: true,
      showBadge: true,
      badgeIntent: 'success',
      expired: false,
      unverified: false,
      streakIntent: 'muted',
    });
  });

  it('UNVERIFIED → progress badge + the "will verify" note', () => {
    const v = deriveCredentialView({ ...base, status: 'UNVERIFIED', lastVerifiedAt: null });
    expect(v.unverified).toBe(true);
    expect(v.badgeIntent).toBe('progress');
    expect(v.expired).toBe(false);
  });

  it('EXPIRED → danger badge + expired warning + a red failure streak', () => {
    const v = deriveCredentialView({
      ...base,
      status: 'EXPIRED',
      failureStreak: 2,
      lastError: 'HTTP 403',
    });
    expect(v.expired).toBe(true);
    expect(v.badgeIntent).toBe('danger');
    expect(v.streakIntent).toBe('danger');
    expect(v.lastError).toBe('HTTP 403');
  });

  it('feature disabled → disabled surface, no badge, nothing to delete', () => {
    const v = deriveCredentialView({
      enabled: false,
      configured: false,
      status: null,
      lastVerifiedAt: null,
      failureStreak: 0,
      lastError: null,
    });
    expect(v).toMatchObject({
      disabled: true,
      configured: false,
      showBadge: false,
      expired: false,
    });
  });
});

describe('testResultView / eventsSummary', () => {
  it('delivered:true is a success result, delivered:false a neutral warning (never an error)', () => {
    expect(testResultView({ delivered: true, detail: 'HTTP 200' })).toEqual({
      ok: true,
      intent: 'success',
      titleKey: 'delivered',
      detail: 'HTTP 200',
    });
    expect(testResultView({ delivered: false, detail: 'HTTP 401' })).toEqual({
      ok: false,
      intent: 'warning',
      titleKey: 'notDelivered',
      detail: 'HTTP 401',
    });
  });

  it('eventsSummary flags the all-events case vs a partial count', () => {
    const all = eventsSummary([
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
    ]);
    expect(all).toEqual({ all: true, count: 11 });
    expect(eventsSummary(['live.start', 'live.stop'])).toEqual({ all: false, count: 2 });
  });
});
