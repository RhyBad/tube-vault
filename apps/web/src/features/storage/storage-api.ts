/**
 * storage-api — S-ST's feature-local binding for EP-34 (vault capacity + the
 * per-channel usage breakdown), on the shared lib/api fetch wrapper (same-origin
 * cookie, 401 redirect, ApiError). The capacity view is READ-ONLY; the cleanup
 * flow's delete verb (EP-40) is the shared `deleteVideos` in features/videos, so
 * this module is a single GET. (Home has its own copy on purpose — the two
 * screens stay decoupled rather than sharing a binding.)
 */
import type { StorageStatsResponse } from '@tubevault/types';

import { apiGet } from '../../lib/api';

/** EP-34 — vault capacity (statfs) + per-channel usage (all channels 0-filled). */
export function getStorageStats(): Promise<StorageStatsResponse> {
  return apiGet<StorageStatsResponse>('/storage');
}
