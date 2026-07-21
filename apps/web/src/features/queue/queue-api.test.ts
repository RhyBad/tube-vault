/**
 * queue-api spec (S6 P1) — thin typed EP-19..26 wrappers. The two things worth
 * locking: (1) the query string is built from only the set filters, and (2)
 * cancel/pause discriminate the 200 settle (`{canceled|paused:true}`) from the
 * 202 signal (`{accepted:true}`) by BODY shape — the api layer discards the HTTP
 * status, so the body is the only discriminator.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../../lib/api', () => apiMock);

import {
  bulkQueue,
  cancelJob,
  enqueue,
  getJobEvents,
  getQueue,
  moveJob,
  pauseJob,
  resumeJob,
} from './queue-api';

afterEach(() => vi.clearAllMocks());

describe('getQueue — query string', () => {
  it('omits unset filters and sends only what is provided', async () => {
    apiMock.apiGet.mockResolvedValue({ items: [], nextCursor: null });
    await getQueue({ limit: 100 });
    expect(apiMock.apiGet).toHaveBeenCalledWith('/queue?limit=100');
  });

  it('serializes status + channelId + cursor', async () => {
    apiMock.apiGet.mockResolvedValue({ items: [], nextCursor: null });
    await getQueue({ status: 'FAILED', channelId: 'c1', limit: 50, cursor: 'abc' });
    const url = apiMock.apiGet.mock.calls[0][0] as string;
    expect(url.startsWith('/queue?')).toBe(true);
    const q = new URLSearchParams(url.slice('/queue?'.length));
    expect(q.get('status')).toBe('FAILED');
    expect(q.get('channelId')).toBe('c1');
    expect(q.get('limit')).toBe('50');
    expect(q.get('cursor')).toBe('abc');
  });
});

describe('cancelJob / pauseJob — 200 settle vs 202 signal', () => {
  it('cancel returns "settled" on {canceled:true} and "signalled" on {accepted:true}', async () => {
    apiMock.apiPost.mockResolvedValueOnce({ canceled: true });
    expect(await cancelJob('j1')).toBe('settled');
    apiMock.apiPost.mockResolvedValueOnce({ accepted: true });
    expect(await cancelJob('j1')).toBe('signalled');
    expect(apiMock.apiPost).toHaveBeenCalledWith('/queue/j1/cancel');
  });

  it('pause returns "settled" on {paused:true} and "signalled" on {accepted:true}', async () => {
    apiMock.apiPost.mockResolvedValueOnce({ paused: true });
    expect(await pauseJob('j2')).toBe('settled');
    apiMock.apiPost.mockResolvedValueOnce({ accepted: true });
    expect(await pauseJob('j2')).toBe('signalled');
  });

  it('url-encodes the jobId', async () => {
    apiMock.apiPost.mockResolvedValue({ canceled: true });
    await cancelJob('a/b');
    expect(apiMock.apiPost).toHaveBeenCalledWith('/queue/a%2Fb/cancel');
  });
});

describe('resume / move / bulk / events / enqueue', () => {
  it('resume posts to the resume path', async () => {
    apiMock.apiPost.mockResolvedValue({ resumed: true });
    await resumeJob('j3');
    expect(apiMock.apiPost).toHaveBeenCalledWith('/queue/j3/resume');
  });

  it('move posts the position/afterJobId body', async () => {
    apiMock.apiPost.mockResolvedValue({ moved: true, priority: 10, renumbered: false });
    await moveJob('j4', { position: 'top' });
    expect(apiMock.apiPost).toHaveBeenCalledWith('/queue/j4/move', { position: 'top' });
  });

  it('bulk posts action + jobIds', async () => {
    apiMock.apiPost.mockResolvedValue({ ok: [], failed: [] });
    await bulkQueue({ action: 'cancel', jobIds: ['a', 'b'] });
    expect(apiMock.apiPost).toHaveBeenCalledWith('/queue/bulk', {
      action: 'cancel',
      jobIds: ['a', 'b'],
    });
  });

  it('getJobEvents GETs the events path', async () => {
    apiMock.apiGet.mockResolvedValue({ events: [] });
    await getJobEvents('j5');
    expect(apiMock.apiGet).toHaveBeenCalledWith('/queue/j5/events');
  });

  it('enqueue posts the filter/videoIds body', async () => {
    apiMock.apiPost.mockResolvedValue({ enqueued: [], skipped: [] });
    await enqueue({ videoIds: ['v1'] });
    expect(apiMock.apiPost).toHaveBeenCalledWith('/queue/enqueue', { videoIds: ['v1'] });
  });
});
