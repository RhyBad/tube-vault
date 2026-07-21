/**
 * live-api spec (S7 P1) — the S7 Live bindings on lib/api's typed helpers:
 * EP-35 live-session snapshot, EP-11 channels (the hook client-filters to
 * watchLive), EP-12 watchLive toggle, EP-15 recently-ended lives
 * (contentType=LIVE, newest-added first), EP-04 credential status (the
 * members-only-live hint). The thing worth locking is the query construction.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPatch: vi.fn(),
}));
vi.mock('../../lib/api', () => apiMock);

import {
  getChannels,
  getLiveSessions,
  getRecentLives,
  getSessionStatus,
  patchWatchLive,
} from './live-api';

afterEach(() => vi.clearAllMocks());

describe('live-api — endpoint bindings', () => {
  it('getLiveSessions / getChannels / getSessionStatus hit their bare paths', async () => {
    apiMock.apiGet.mockResolvedValue({});
    await getLiveSessions();
    await getChannels();
    await getSessionStatus();
    expect(apiMock.apiGet.mock.calls.map((c) => c[0])).toEqual([
      '/live-sessions',
      '/channels',
      '/session',
    ]);
  });

  it('getRecentLives requests LIVE recordings, newest-added first, at the given limit', async () => {
    apiMock.apiGet.mockResolvedValue({ videos: [], total: 0 });
    await getRecentLives(12);
    const url = apiMock.apiGet.mock.calls[0][0] as string;
    expect(url.startsWith('/videos?')).toBe(true);
    const q = new URLSearchParams(url.slice('/videos?'.length));
    expect(q.get('contentType')).toBe('LIVE');
    expect(q.get('sort')).toBe('addedAt_desc');
    expect(q.get('limit')).toBe('12');
  });

  it('patchWatchLive PATCHes the encoded channel path with a strict {watchLive} body', async () => {
    apiMock.apiPatch.mockResolvedValue({});
    await patchWatchLive('UC a', true);
    expect(apiMock.apiPatch).toHaveBeenCalledWith(`/channels/${encodeURIComponent('UC a')}`, {
      watchLive: true,
    });

    await patchWatchLive('UC1', false);
    expect(apiMock.apiPatch).toHaveBeenLastCalledWith('/channels/UC1', { watchLive: false });
  });
});
