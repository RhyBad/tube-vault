/**
 * notifications-api spec (S8 P1) — thin typed EP-27/28/41/42 wrappers. Locks:
 * the query string carries only the set filters (undismissed only when true),
 * dismiss verbs hit the right paths, and the id is url-encoded.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../../lib/api', () => apiMock);

import {
  bulkDismissNotifications,
  dismissAllNotifications,
  dismissNotification,
  getNotifications,
} from './notifications-api';

afterEach(() => vi.clearAllMocks());

describe('getNotifications — query string', () => {
  it('sends no query when nothing is set', async () => {
    apiMock.apiGet.mockResolvedValue({ notifications: [], nextCursor: null });
    await getNotifications();
    expect(apiMock.apiGet).toHaveBeenCalledWith('/notifications');
  });

  it('emits undismissed only when true', async () => {
    apiMock.apiGet.mockResolvedValue({ notifications: [], nextCursor: null });
    await getNotifications({ undismissed: false, limit: 50 });
    expect(apiMock.apiGet).toHaveBeenCalledWith('/notifications?limit=50');
  });

  it('serializes undismissed + limit + cursor', async () => {
    apiMock.apiGet.mockResolvedValue({ notifications: [], nextCursor: null });
    await getNotifications({ undismissed: true, limit: 100, cursor: 'n_9' });
    const url = apiMock.apiGet.mock.calls[0][0] as string;
    const q = new URLSearchParams(url.slice('/notifications?'.length));
    expect(q.get('undismissed')).toBe('true');
    expect(q.get('limit')).toBe('100');
    expect(q.get('cursor')).toBe('n_9');
  });
});

describe('dismiss verbs', () => {
  it('dismissNotification posts to the id-scoped path (url-encoded)', async () => {
    apiMock.apiPost.mockResolvedValue({ notification: {} });
    await dismissNotification('a b/c');
    expect(apiMock.apiPost).toHaveBeenCalledWith('/notifications/a%20b%2Fc/dismiss');
  });

  it('dismissAllNotifications posts to /dismiss-all', async () => {
    apiMock.apiPost.mockResolvedValue({ dismissed: 3 });
    await dismissAllNotifications();
    expect(apiMock.apiPost).toHaveBeenCalledWith('/notifications/dismiss-all');
  });

  it('bulkDismissNotifications posts the id batch to /dismiss', async () => {
    apiMock.apiPost.mockResolvedValue({ dismissed: 2, failed: [] });
    await bulkDismissNotifications(['x', 'y']);
    expect(apiMock.apiPost).toHaveBeenCalledWith('/notifications/dismiss', { ids: ['x', 'y'] });
  });
});
