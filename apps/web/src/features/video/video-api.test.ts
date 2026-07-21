/**
 * video-api spec (S5 P1) — the S5 video-detail bindings on lib/api's typed
 * helpers: EP-16 single-video detail (a 404 resolves to `null` so the page can
 * treat an unknown id as not-found → redirect to S4), EP-36 the subtitle list
 * (a known video with no tracks is a 200 `{subtitles:[]}`, not an error), and
 * the same-origin media/thumbnail/subtitle URL builders (those go straight into
 * <video src>/<a href>/<track src>, so they carry the `/api` prefix and are
 * component-encoded — they never pass through the lib/api wrapper).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JobStatus, VideoDetailResponse, VideoDto } from '@tubevault/types';

const apiMock = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../../lib/api', async (orig) => {
  // Keep the real ApiError (getVideoDetail discriminates a 404 on it); stub only
  // the fetch verbs so we assert the path/return without touching the network.
  const actual = await orig<typeof import('../../lib/api')>();
  return { ...actual, apiGet: apiMock.apiGet, apiPost: apiMock.apiPost };
});

import { ApiError } from '../../lib/api';
import {
  getSubtitles,
  getVideoDetail,
  mediaUrl,
  subtitleTrackUrl,
  thumbnailUrl,
} from './video-api';

afterEach(() => vi.clearAllMocks());

function video(id: string): VideoDto {
  return {
    id,
    channelId: 'UC1',
    title: 'A video',
    contentType: 'REGULAR',
    copyState: 'HEALTHY',
    sourceState: 'AVAILABLE',
    publishedAt: '2026-07-01T00:00:00.000Z',
    addedAt: '2026-07-02T00:00:00.000Z',
    mediaExt: 'mp4',
    sizeBytes: 1024,
    checksumSha256: 'abc',
    width: 1920,
    height: 1080,
    sourceDurationSeconds: 600,
  };
}

function detail(id: string, over: Partial<VideoDetailResponse> = {}): VideoDetailResponse {
  return {
    video: video(id),
    channelTitle: 'A channel',
    description: null,
    activeDownloadJobId: null,
    activeDownloadStatus: null as JobStatus | null,
    events: [],
    ...over,
  };
}

describe('video-api — EP-16 getVideoDetail', () => {
  it('GETs the (encoded) video path and returns the detail envelope', async () => {
    apiMock.apiGet.mockResolvedValue(detail('vid 1'));
    const res = await getVideoDetail('vid 1');
    expect(apiMock.apiGet).toHaveBeenCalledWith(`/videos/${encodeURIComponent('vid 1')}`);
    expect(res?.channelTitle).toBe('A channel');
  });

  it('resolves to null on a 404 (unknown video → page redirects to the library)', async () => {
    apiMock.apiGet.mockRejectedValue(new ApiError(404, 'unknown video: x'));
    expect(await getVideoDetail('x')).toBeNull();
  });

  it('re-throws a non-404 error (a real failure must surface, not read as not-found)', async () => {
    apiMock.apiGet.mockRejectedValue(new ApiError(500, 'boom'));
    await expect(getVideoDetail('x')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('video-api — EP-36 getSubtitles', () => {
  it('GETs the subtitle-list path and returns the tracks', async () => {
    apiMock.apiGet.mockResolvedValue({ subtitles: [{ lang: 'en', format: 'vtt' }] });
    const res = await getSubtitles('vid1');
    expect(apiMock.apiGet).toHaveBeenCalledWith('/media/vid1/subtitles');
    expect(res.subtitles).toHaveLength(1);
  });

  it('passes through the empty list (a video with no tracks is 200 {subtitles:[]})', async () => {
    apiMock.apiGet.mockResolvedValue({ subtitles: [] });
    expect((await getSubtitles('vid1')).subtitles).toEqual([]);
  });
});

describe('video-api — same-origin media URL builders (carry /api, component-encoded)', () => {
  it('mediaUrl → /api/media/:id (EP-17)', () => {
    expect(mediaUrl('a/b')).toBe(`/api/media/${encodeURIComponent('a/b')}`);
  });
  it('thumbnailUrl → /api/media/:id/thumbnail (EP-18)', () => {
    expect(thumbnailUrl('a b')).toBe(`/api/media/${encodeURIComponent('a b')}/thumbnail`);
  });
  it('subtitleTrackUrl → /api/media/:id/subtitles/:lang (EP-37, both parts encoded)', () => {
    expect(subtitleTrackUrl('a b', 'en-US')).toBe(
      `/api/media/${encodeURIComponent('a b')}/subtitles/${encodeURIComponent('en-US')}`,
    );
  });
});
