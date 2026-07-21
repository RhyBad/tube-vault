/**
 * channel-api spec (S3 P1) — the S3 channel bindings: EP-11 single-channel meta
 * (no single-GET exists, so we take it from the full list — spec §8/§12), EP-12
 * partial patch (watchLive + CR-04 policy, `null` clears an override), EP-38
 * delete (default soft "unregister" vs `?purgeMedia=true` hard purge). All on
 * lib/api's typed helpers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChannelDto } from '@tubevault/types';

const apiMock = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));
vi.mock('../../lib/api', () => apiMock);

import { deleteChannel, getChannel, patchChannel, registerChannel } from './channel-api';

afterEach(() => vi.clearAllMocks());

function channel(id: string, title: string): ChannelDto {
  return {
    id,
    url: `https://youtube.com/${id}`,
    title,
    handle: `@${title}`,
    watchLive: false,
    qualityCap: null,
    subtitleMode: null,
    unregisteredAt: null,
    lastEnumeratedAt: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    videoCounts: { total: 0, candidates: 0, healthy: 0 },
  };
}

describe('channel-api — EP-11 getChannel (list → find)', () => {
  it('returns the matching channel from the full list', async () => {
    apiMock.apiGet.mockResolvedValue({ channels: [channel('UC1', 'a'), channel('UC2', 'b')] });
    const found = await getChannel('UC2');
    expect(apiMock.apiGet).toHaveBeenCalledWith('/channels');
    expect(found?.id).toBe('UC2');
  });

  it('returns null when the id is not in the list (404-equivalent → page redirects)', async () => {
    apiMock.apiGet.mockResolvedValue({ channels: [channel('UC1', 'a')] });
    expect(await getChannel('UC_missing')).toBeNull();
  });
});

describe('channel-api — EP-12 patchChannel', () => {
  it('PATCHes the (encoded) channel path with the partial body', async () => {
    apiMock.apiPatch.mockResolvedValue(channel('UC1', 'a'));
    await patchChannel('UC 1', { watchLive: true });
    expect(apiMock.apiPatch).toHaveBeenCalledWith(`/channels/${encodeURIComponent('UC 1')}`, {
      watchLive: true,
    });
  });

  it('passes an explicit null through (clear a policy override → inherit global)', async () => {
    apiMock.apiPatch.mockResolvedValue(channel('UC1', 'a'));
    await patchChannel('UC1', { qualityCap: null, subtitleMode: 'AUTO' });
    expect(apiMock.apiPatch).toHaveBeenCalledWith('/channels/UC1', {
      qualityCap: null,
      subtitleMode: 'AUTO',
    });
  });
});

describe('channel-api — EP-38 deleteChannel', () => {
  it('defaults to the safe unregister (no purge query)', async () => {
    apiMock.apiDelete.mockResolvedValue({ channelId: 'UC1', mode: 'unregistered' });
    await deleteChannel('UC1');
    expect(apiMock.apiDelete).toHaveBeenCalledWith('/channels/UC1');
  });

  it('appends ?purgeMedia=true for a hard delete', async () => {
    apiMock.apiDelete.mockResolvedValue({ channelId: 'UC1', mode: 'purged' });
    await deleteChannel('UC1', { purgeMedia: true });
    expect(apiMock.apiDelete).toHaveBeenCalledWith('/channels/UC1?purgeMedia=true');
  });

  it('encodes the id in the delete path', async () => {
    apiMock.apiDelete.mockResolvedValue({ channelId: 'UC/1', mode: 'unregistered' });
    await deleteChannel('UC/1', { purgeMedia: false });
    expect(apiMock.apiDelete).toHaveBeenCalledWith(`/channels/${encodeURIComponent('UC/1')}`);
  });
});

describe('channel-api — EP-10 registerChannel (re-register)', () => {
  it('POSTs the channel url (re-registering clears unregisteredAt server-side)', async () => {
    apiMock.apiPost.mockResolvedValue({ channel: channel('UC1', 'a'), alreadyRegistered: true });
    await registerChannel('https://youtube.com/@x');
    expect(apiMock.apiPost).toHaveBeenCalledWith('/channels', { url: 'https://youtube.com/@x' });
  });
});
