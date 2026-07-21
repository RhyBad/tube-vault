/**
 * videos-api spec (S3 P1) — the shared find bindings the VideosBrowser consumes
 * (EP-13 per-channel · EP-15 cross-channel), layered on lib/api's apiGet. The
 * contract worth locking is the query-string construction: every filter is
 * OPTIONAL and only appended when set, `rescued` is the literal `'true'` string
 * (never `'false'`, to dodge the server's z.coerce trap), the channel route
 * fixes the id in the PATH (never a query param), and blanks are omitted so a
 * cleared filter reverts to "no constraint" rather than an empty-string 400.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../../lib/api', () => apiMock);

import { deleteVideos, enqueueVideos, getChannelVideos, getVideos } from './videos-api';

afterEach(() => vi.clearAllMocks());

function paramsOf(url: string, base: string): URLSearchParams {
  const prefix = `${base}?`;
  expect(url.startsWith(prefix)).toBe(true);
  return new URLSearchParams(url.slice(prefix.length));
}

describe('videos-api — EP-13 getChannelVideos', () => {
  it('fixes the channel in the PATH and defaults to a bare listing', async () => {
    apiMock.apiGet.mockResolvedValue({ videos: [], total: 0 });
    await getChannelVideos('UC_abc', {});
    const url = apiMock.apiGet.mock.calls[0][0] as string;
    // No query at all when nothing is set (path only, no trailing '?').
    expect(url).toBe('/channels/UC_abc/videos');
  });

  it('url-encodes the channel id in the path', async () => {
    apiMock.apiGet.mockResolvedValue({ videos: [], total: 0 });
    await getChannelVideos('UC a/b', {});
    const url = apiMock.apiGet.mock.calls[0][0] as string;
    expect(url).toBe(`/channels/${encodeURIComponent('UC a/b')}/videos`);
  });

  it('serializes every filter as an AND-composed query param', async () => {
    apiMock.apiGet.mockResolvedValue({ videos: [], total: 0 });
    await getChannelVideos('UC1', {
      search: 'tape deck',
      copyState: 'HEALTHY',
      sourceState: 'DELETED',
      contentType: 'LIVE',
      rescued: true,
      publishedFrom: '2020-01-01T00:00:00.000Z',
      publishedTo: '2020-12-31T23:59:59.999Z',
      sort: 'title_asc',
      limit: 50,
      offset: 100,
    });
    const q = paramsOf(apiMock.apiGet.mock.calls[0][0] as string, '/channels/UC1/videos');
    expect(q.get('search')).toBe('tape deck');
    expect(q.get('copyState')).toBe('HEALTHY');
    expect(q.get('sourceState')).toBe('DELETED');
    expect(q.get('contentType')).toBe('LIVE');
    expect(q.get('rescued')).toBe('true');
    expect(q.get('publishedFrom')).toBe('2020-01-01T00:00:00.000Z');
    expect(q.get('publishedTo')).toBe('2020-12-31T23:59:59.999Z');
    expect(q.get('sort')).toBe('title_asc');
    expect(q.get('limit')).toBe('50');
    expect(q.get('offset')).toBe('100');
  });

  it('omits rescued entirely when false (never sends the string "false")', async () => {
    apiMock.apiGet.mockResolvedValue({ videos: [], total: 0 });
    await getChannelVideos('UC1', { rescued: false, copyState: 'CANDIDATE' });
    const q = paramsOf(apiMock.apiGet.mock.calls[0][0] as string, '/channels/UC1/videos');
    expect(q.has('rescued')).toBe(false);
    expect(q.get('copyState')).toBe('CANDIDATE');
  });

  it('omits blank search / undefined filters (a cleared filter = no constraint)', async () => {
    apiMock.apiGet.mockResolvedValue({ videos: [], total: 0 });
    await getChannelVideos('UC1', {
      search: '',
      copyState: undefined,
      offset: 0,
      sort: 'publishedAt_desc',
    });
    const q = paramsOf(apiMock.apiGet.mock.calls[0][0] as string, '/channels/UC1/videos');
    expect(q.has('search')).toBe(false);
    expect(q.has('copyState')).toBe(false);
    // offset 0 is the default — omit it (keeps the URL clean / cacheable).
    expect(q.has('offset')).toBe(false);
    expect(q.get('sort')).toBe('publishedAt_desc');
  });

  it('serializes sizeFrom (a bytes lower bound, e.g. Storage cleanup)', async () => {
    apiMock.apiGet.mockResolvedValue({ videos: [], total: 0 });
    await getChannelVideos('UC1', { sizeFrom: 1_000_000 });
    const q = paramsOf(apiMock.apiGet.mock.calls[0][0] as string, '/channels/UC1/videos');
    expect(q.get('sizeFrom')).toBe('1000000');
  });

  it('omits sizeFrom when undefined or <= 0', async () => {
    apiMock.apiGet.mockResolvedValue({ videos: [], total: 0 });
    // pair with a set filter so the query string is non-empty either way
    await getChannelVideos('UC1', { sizeFrom: undefined, sort: 'title_asc' });
    let q = paramsOf(apiMock.apiGet.mock.calls[0][0] as string, '/channels/UC1/videos');
    expect(q.has('sizeFrom')).toBe(false);

    await getChannelVideos('UC1', { sizeFrom: 0, sort: 'title_asc' });
    q = paramsOf(apiMock.apiGet.mock.calls[1][0] as string, '/channels/UC1/videos');
    expect(q.has('sizeFrom')).toBe(false);
  });
});

describe('videos-api — EP-15 getVideos (cross-channel, S4)', () => {
  it('hits /videos and passes channelId as a query filter (not a path)', async () => {
    apiMock.apiGet.mockResolvedValue({ videos: [], total: 0 });
    await getVideos({ channelId: 'UC9', search: 'x', limit: 20 });
    const q = paramsOf(apiMock.apiGet.mock.calls[0][0] as string, '/videos');
    expect(q.get('channelId')).toBe('UC9');
    expect(q.get('search')).toBe('x');
    expect(q.get('limit')).toBe('20');
  });
});

describe('videos-api — EP-19 enqueueVideos (shared acquire)', () => {
  it('POSTs a filter selection (channel back-up-all) verbatim', async () => {
    apiMock.apiPost.mockResolvedValue({ enqueued: [], skipped: [] });
    const body = { filter: { channelId: 'UC1', copyState: 'CANDIDATE' as const } };
    await enqueueVideos(body);
    expect(apiMock.apiPost).toHaveBeenCalledWith('/queue/enqueue', body);
  });

  it('POSTs an explicit id selection (download N selected)', async () => {
    apiMock.apiPost.mockResolvedValue({ enqueued: ['a'], skipped: [] });
    await enqueueVideos({ videoIds: ['a', 'b'] });
    expect(apiMock.apiPost).toHaveBeenCalledWith('/queue/enqueue', { videoIds: ['a', 'b'] });
  });
});

describe('videos-api — EP-40 deleteVideos (bulk reclaim/purge, CR-27)', () => {
  it('POSTs the id batch + mode to /videos/delete', async () => {
    apiMock.apiPost.mockResolvedValue({ deleted: ['a'], freedBytes: 100, failed: [] });
    const res = await deleteVideos(['a', 'b'], 'reclaim');
    expect(apiMock.apiPost).toHaveBeenCalledWith('/videos/delete', {
      videoIds: ['a', 'b'],
      mode: 'reclaim',
    });
    expect(res).toEqual({ deleted: ['a'], freedBytes: 100, failed: [] });
  });

  it('passes the purge mode through verbatim', async () => {
    apiMock.apiPost.mockResolvedValue({ deleted: [], freedBytes: 0, failed: [] });
    await deleteVideos(['c'], 'purge');
    expect(apiMock.apiPost).toHaveBeenCalledWith('/videos/delete', {
      videoIds: ['c'],
      mode: 'purge',
    });
  });
});
