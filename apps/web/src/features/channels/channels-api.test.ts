/**
 * channels-api spec (S2 P1) — the channel-LIST bindings on lib/api's typed
 * helpers: EP-11 list (all channels), EP-10 register (url → enumerate job),
 * EP-12 watchLive toggle, EP-38 delete (soft unregister default / hard purge).
 * What's worth locking is the path/verb/body + the purge query construction.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));
vi.mock('../../lib/api', () => apiMock);

import { deleteChannel, getChannels, patchWatchLive, registerChannel } from './channels-api';

afterEach(() => vi.clearAllMocks());

describe('channels-api — endpoint bindings', () => {
  it('getChannels GETs the bare list path (EP-11)', async () => {
    apiMock.apiGet.mockResolvedValue({ channels: [] });
    await getChannels();
    expect(apiMock.apiGet).toHaveBeenCalledWith('/channels');
  });

  it('registerChannel POSTs {url} to /channels (EP-10)', async () => {
    apiMock.apiPost.mockResolvedValue({});
    await registerChannel('https://youtube.com/@x');
    expect(apiMock.apiPost).toHaveBeenCalledWith('/channels', {
      url: 'https://youtube.com/@x',
    });
  });

  it('patchWatchLive PATCHes the encoded path with a strict {watchLive} body (EP-12)', async () => {
    apiMock.apiPatch.mockResolvedValue({});
    await patchWatchLive('UC a', true);
    expect(apiMock.apiPatch).toHaveBeenCalledWith(`/channels/${encodeURIComponent('UC a')}`, {
      watchLive: true,
    });
    await patchWatchLive('UC1', false);
    expect(apiMock.apiPatch).toHaveBeenLastCalledWith('/channels/UC1', { watchLive: false });
  });

  it('deleteChannel defaults to a soft unregister — no purge query (EP-38)', async () => {
    apiMock.apiDelete.mockResolvedValue({});
    await deleteChannel('UC1');
    expect(apiMock.apiDelete).toHaveBeenCalledWith('/channels/UC1');
  });

  it('deleteChannel adds ?purgeMedia=true only for a hard purge (EP-38)', async () => {
    apiMock.apiDelete.mockResolvedValue({});
    await deleteChannel('UC a', { purgeMedia: true });
    expect(apiMock.apiDelete).toHaveBeenCalledWith(
      `/channels/${encodeURIComponent('UC a')}?purgeMedia=true`,
    );

    await deleteChannel('UC1', { purgeMedia: false });
    expect(apiMock.apiDelete).toHaveBeenLastCalledWith('/channels/UC1');
  });
});
