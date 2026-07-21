/**
 * Unit: notification-channel secrets are registered for redaction the moment
 * they enter the system (create/patch) — v1 defense-in-depth parity: v1
 * registered every channel secret before any network use, so a leaked token
 * can never surface verbatim in logs even if some future code path echoes it.
 * Prisma is faked; the assertion is on the engine redactor itself.
 */
import type { NotificationChannel } from '@tubevault/db';
import { PrismaClient } from '@tubevault/db';
import { clearRegisteredSecrets, redact } from '@tubevault/engine';
import { afterEach, describe, expect, it } from 'vitest';

import { NotificationChannelsService } from './notification-channels.service';

const TG_TOKEN = '7100000001:register-me-for-redaction-000';
const HOOK_URL = 'https://hooks.example/secret-path-abcdef123456';

function fakePrisma(stored?: NotificationChannel): PrismaClient {
  const now = new Date();
  return {
    notificationChannel: {
      create: ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'chan1', createdAt: now, updatedAt: now, ...data }),
      findUnique: () => Promise.resolve(stored ?? null),
      update: ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...stored, ...data, updatedAt: now }),
    },
  } as unknown as PrismaClient;
}

describe('NotificationChannelsService secret registration (P8 defense-in-depth)', () => {
  afterEach(() => {
    clearRegisteredSecrets();
  });

  it('create() registers the telegram botToken so redact() masks it', async () => {
    const svc = new NotificationChannelsService(fakePrisma());
    await svc.create({ type: 'TELEGRAM', name: 't', config: { botToken: TG_TOKEN, chatId: '1' } });
    const swept = redact(`oops ${TG_TOKEN} leaked`);
    expect(swept).not.toContain(TG_TOKEN);
    expect(swept).toContain('***REDACTED***');
  });

  it('update() registers a replaced webhook url (the whole URL is the secret)', async () => {
    const now = new Date();
    const stored = {
      id: 'chan1',
      type: 'WEBHOOK',
      name: 'w',
      config: { url: 'https://old.example/x' },
      events: ['system.test'],
      minSeverity: 'INFO',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    } as unknown as NotificationChannel;
    const svc = new NotificationChannelsService(fakePrisma(stored));
    await svc.update('chan1', { config: { url: HOOK_URL } });
    const swept = redact(`dispatch to ${HOOK_URL} failed`);
    expect(swept).not.toContain(HOOK_URL);
    expect(swept).toContain('***REDACTED***');
  });
});
