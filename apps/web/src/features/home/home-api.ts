/**
 * home-api — typed bindings for the five READ-ONLY endpoints the Home overview
 * consumes (EP-20 queue · EP-34 storage · EP-15 videos · EP-11 channels · EP-35
 * live-sessions), layered on the shared lib/api fetch wrapper (same-origin cookie,
 * 401 redirect, ApiError). Home never mutates — control lives on S6/S7/S3/S-ST — so
 * these are all GETs, each sized for a "3-second glance" (small limits, spec §9).
 */
import type {
  ChannelListResponse,
  LiveSessionListResponse,
  QueueListResponse,
  StorageStatsResponse,
  VideoListResponse,
} from '@tubevault/types';

import { apiGet } from '../../lib/api';

/**
 * EP-20 — the active DOWNLOAD band (QUEUED+RUNNING+PAUSED; omitting `status` is
 * the server default). Home only ever wants a summary-sized page, so it passes a
 * small `limit` and reads `nextCursor` to know whether the queue tail is deeper
 * than what it shows (it never loads the whole queue — that's S6).
 */
export function getActiveQueue(limit: number): Promise<QueueListResponse> {
  return apiGet<QueueListResponse>(`/queue?limit=${encodeURIComponent(String(limit))}`);
}

/** EP-34 — vault capacity (statfs) + per-channel usage breakdown. */
export function getStorageStats(): Promise<StorageStatsResponse> {
  return apiGet<StorageStatsResponse>('/storage');
}

/** EP-15 — cross-channel videos, newest-ARCHIVED first (the "just came in" feed). */
export function getRecentVideos(limit: number): Promise<VideoListResponse> {
  const params = new URLSearchParams({ sort: 'addedAt_desc', limit: String(limit) });
  return apiGet<VideoListResponse>(`/videos?${params.toString()}`);
}

/** EP-11 — every registered channel + its video counts (no pagination). */
export function getChannels(): Promise<ChannelListResponse> {
  return apiGet<ChannelListResponse>('/channels');
}

/** EP-35 — the active live-session snapshot (state ∈ {DETECTED, CAPTURING}). */
export function getLiveSessions(): Promise<LiveSessionListResponse> {
  return apiGet<LiveSessionListResponse>('/live-sessions');
}
