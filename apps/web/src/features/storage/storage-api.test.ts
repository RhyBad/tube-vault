/**
 * storage-api spec (S-ST P1) — the feature-local binding for EP-34 (the vault
 * capacity + per-channel breakdown). S-ST owns its own binding rather than
 * importing home's, so the two screens stay decoupled. Only the bare path matters.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../../lib/api', () => apiMock);

import { getStorageStats } from './storage-api';

afterEach(() => vi.clearAllMocks());

describe('storage-api', () => {
  it('getStorageStats GETs /storage', async () => {
    apiMock.apiGet.mockResolvedValue({ vault: {}, channels: [] });
    await getStorageStats();
    expect(apiMock.apiGet.mock.calls[0][0]).toBe('/storage');
  });
});
