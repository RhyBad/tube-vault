/**
 * settings-api spec (S9 P1) — the S9 Settings bindings on lib/api's typed
 * helpers, one group per independent backend (spec §1): global defaults
 * (EP-07/08), notification channels (EP-29..33), and the YouTube credential
 * (EP-04/05/06). The thing worth locking is path + verb + body shape.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPatch: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));
vi.mock('../../lib/api', () => apiMock);

import {
  createNotificationChannel,
  deleteNotificationChannel,
  deleteSession,
  getNotificationChannels,
  getSessionStatus,
  getSettings,
  importCookies,
  patchNotificationChannel,
  patchSettings,
  testNotificationChannel,
} from './settings-api';

afterEach(() => vi.clearAllMocks());

describe('settings-api — global defaults (EP-07/08)', () => {
  it('getSettings GETs the bare /settings path', async () => {
    apiMock.apiGet.mockResolvedValue({});
    await getSettings();
    expect(apiMock.apiGet).toHaveBeenCalledWith('/settings');
  });

  it('patchSettings PATCHes /settings with the partial body', async () => {
    apiMock.apiPatch.mockResolvedValue({});
    await patchSettings({ downloadConcurrency: 3 });
    expect(apiMock.apiPatch).toHaveBeenCalledWith('/settings', { downloadConcurrency: 3 });
  });
});

describe('settings-api — notification channels (EP-29..33)', () => {
  it('getNotificationChannels GETs the list path', async () => {
    apiMock.apiGet.mockResolvedValue({ channels: [] });
    await getNotificationChannels();
    expect(apiMock.apiGet).toHaveBeenCalledWith('/notification-channels');
  });

  it('createNotificationChannel POSTs the create body', async () => {
    apiMock.apiPost.mockResolvedValue({});
    const body = { type: 'DISCORD' as const, name: 'Ops', config: { webhookUrl: 'https://x' } };
    await createNotificationChannel(body);
    expect(apiMock.apiPost).toHaveBeenCalledWith('/notification-channels', body);
  });

  it('patchNotificationChannel PATCHes the encoded id path with the merge body', async () => {
    apiMock.apiPatch.mockResolvedValue({});
    await patchNotificationChannel('nc 1', { name: 'Renamed' });
    expect(apiMock.apiPatch).toHaveBeenCalledWith(
      `/notification-channels/${encodeURIComponent('nc 1')}`,
      { name: 'Renamed' },
    );
  });

  it('deleteNotificationChannel DELETEs the encoded id path', async () => {
    apiMock.apiDelete.mockResolvedValue({ deleted: true });
    await deleteNotificationChannel('nc1');
    expect(apiMock.apiDelete).toHaveBeenCalledWith('/notification-channels/nc1');
  });

  it('testNotificationChannel POSTs the /test sub-path (no body)', async () => {
    apiMock.apiPost.mockResolvedValue({ delivered: true, detail: 'HTTP 200' });
    await testNotificationChannel('nc1');
    expect(apiMock.apiPost).toHaveBeenCalledWith('/notification-channels/nc1/test');
  });
});

describe('settings-api — YouTube credential (EP-04/05/06)', () => {
  it('getSessionStatus GETs /session', async () => {
    apiMock.apiGet.mockResolvedValue({});
    await getSessionStatus();
    expect(apiMock.apiGet).toHaveBeenCalledWith('/session');
  });

  it('importCookies PUTs /session with a {cookies} body', async () => {
    apiMock.apiPut.mockResolvedValue({});
    await importCookies('# Netscape…');
    expect(apiMock.apiPut).toHaveBeenCalledWith('/session', { cookies: '# Netscape…' });
  });

  it('deleteSession DELETEs /session', async () => {
    apiMock.apiDelete.mockResolvedValue({});
    await deleteSession();
    expect(apiMock.apiDelete).toHaveBeenCalledWith('/session');
  });
});
