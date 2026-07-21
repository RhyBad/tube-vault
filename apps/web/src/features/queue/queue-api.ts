/**
 * queue-api — typed bindings for the S6 queue endpoints (EP-19..26), layered on
 * the shared lib/api fetch wrapper (same-origin cookie, 401 redirect, ApiError).
 * Each function reads as intent, not RequestInit plumbing.
 *
 * cancel/pause are the subtle ones: the api returns 200 `{canceled|paused:true}`
 * when the job settles synchronously, or 202 `{accepted:true}` when a RUNNING job
 * was only SIGNALLED (the worker settles it and the client observes job.changed).
 * lib/api discards the HTTP status on success, so we discriminate on the body.
 */
import type {
  EnqueueRequest,
  EnqueueResponse,
  JobEventsResponse,
  JobStatus,
  QueueBulkRequest,
  QueueBulkResponse,
  QueueListResponse,
  QueueMoveRequest,
  QueueMoveResponse,
} from '@tubevault/types';

import { apiGet, apiPost } from '../../lib/api';

export interface QueueQuery {
  /** Omit for the active view (server returns QUEUED+RUNNING+PAUSED). */
  status?: JobStatus;
  channelId?: string;
  limit?: number;
  cursor?: string;
}

export function getQueue(query: QueueQuery): Promise<QueueListResponse> {
  const params = new URLSearchParams();
  if (query.status !== undefined) params.set('status', query.status);
  if (query.channelId !== undefined && query.channelId !== '') {
    params.set('channelId', query.channelId);
  }
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor !== undefined && query.cursor !== '') params.set('cursor', query.cursor);
  const qs = params.toString();
  return apiGet<QueueListResponse>(`/queue${qs ? `?${qs}` : ''}`);
}

/** 'settled' = resolved here-and-now (200); 'signalled' = worker will settle (202). */
export type ControlOutcome = 'settled' | 'signalled';

export async function cancelJob(jobId: string): Promise<ControlOutcome> {
  const res = await apiPost<{ canceled?: true; accepted?: true }>(
    `/queue/${encodeURIComponent(jobId)}/cancel`,
  );
  return res?.accepted === true ? 'signalled' : 'settled';
}

export async function pauseJob(jobId: string): Promise<ControlOutcome> {
  const res = await apiPost<{ paused?: true; accepted?: true }>(
    `/queue/${encodeURIComponent(jobId)}/pause`,
  );
  return res?.accepted === true ? 'signalled' : 'settled';
}

export function resumeJob(jobId: string): Promise<{ resumed: true }> {
  return apiPost<{ resumed: true }>(`/queue/${encodeURIComponent(jobId)}/resume`);
}

export function moveJob(jobId: string, body: QueueMoveRequest): Promise<QueueMoveResponse> {
  return apiPost<QueueMoveResponse>(`/queue/${encodeURIComponent(jobId)}/move`, body);
}

export function bulkQueue(body: QueueBulkRequest): Promise<QueueBulkResponse> {
  return apiPost<QueueBulkResponse>('/queue/bulk', body);
}

export function getJobEvents(jobId: string): Promise<JobEventsResponse> {
  return apiGet<JobEventsResponse>(`/queue/${encodeURIComponent(jobId)}/events`);
}

export function enqueue(body: EnqueueRequest): Promise<EnqueueResponse> {
  return apiPost<EnqueueResponse>('/queue/enqueue', body);
}
