/**
 * home-api spec (S1 P1) — thin typed bindings for the five read-only endpoints
 * the Home widgets consume (EP-20/34/15/11/35), layered on lib/api's apiGet.
 * The only thing worth locking here is the query-string construction: the active
 * queue is summary-sized (a small limit, no status = the active band), and the
 * recent feed is newest-archived-first (sort=addedAt_desc).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../../lib/api', () => apiMock);

import {
  getActiveQueue,
  getChannels,
  getLiveSessions,
  getRecentVideos,
  getStorageStats,
} from './home-api';

afterEach(() => vi.clearAllMocks());

describe('home-api — endpoint bindings', () => {
  it('getActiveQueue requests the active band at the summary limit (no status)', async () => {
    apiMock.apiGet.mockResolvedValue({ items: [], nextCursor: null });
    await getActiveQueue(6);
    const url = apiMock.apiGet.mock.calls[0][0] as string;
    expect(url.startsWith('/queue?')).toBe(true);
    const q = new URLSearchParams(url.slice('/queue?'.length));
    expect(q.get('limit')).toBe('6');
    expect(q.get('status')).toBeNull(); // active = QUEUED+RUNNING+PAUSED (server default)
  });

  it('getRecentVideos requests newest-archived-first at the given limit', async () => {
    apiMock.apiGet.mockResolvedValue({ videos: [], total: 0 });
    await getRecentVideos(6);
    const url = apiMock.apiGet.mock.calls[0][0] as string;
    expect(url.startsWith('/videos?')).toBe(true);
    const q = new URLSearchParams(url.slice('/videos?'.length));
    expect(q.get('sort')).toBe('addedAt_desc');
    expect(q.get('limit')).toBe('6');
  });

  it('getStorageStats / getChannels / getLiveSessions hit their bare paths', async () => {
    apiMock.apiGet.mockResolvedValue({});
    await getStorageStats();
    await getChannels();
    await getLiveSessions();
    const paths = apiMock.apiGet.mock.calls.map((c) => c[0]);
    expect(paths).toEqual(['/storage', '/channels', '/live-sessions']);
  });
});
