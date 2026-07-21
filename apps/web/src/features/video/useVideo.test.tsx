/**
 * useVideo spec (S5 P3) — the S5 data source: EP-16 detail (gates loading /
 * error / notFound), the NON-FATAL EP-36 subtitle side-probe (a failure must not
 * blow away a loaded video), and the spec-§9 realtime reducer: video.changed
 * (this id) patches the 2-axis badges + refetches the trail, job.progress (the
 * active job) patches the progress readout, job.changed (the active job) tracks
 * the status and refetches on a terminal, and reconnected refetches everything.
 * A monotonic token drops out-of-order landings; the optimistic controlPending
 * lifecycle auto-clears on the confirming job.changed.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  JobProgressPayload,
  JobStatus,
  VideoDetailResponse,
  VideoDto,
} from '@tubevault/types';

import type { SseEvent } from '../../lib/sse';
import { SseProvider } from '../../ds/shell/SseProvider';
import type { SseClientLike } from '../../ds/shell/useSseStatus';

const api = vi.hoisted(() => ({ getVideoDetail: vi.fn(), getSubtitles: vi.fn() }));
vi.mock('./video-api', () => api);

import { useVideo } from './useVideo';

function videoDto(over: Partial<VideoDto> = {}): VideoDto {
  return {
    id: 'v1',
    channelId: 'UC1',
    title: 'A video',
    contentType: 'REGULAR',
    copyState: 'DOWNLOADING',
    sourceState: 'AVAILABLE',
    publishedAt: '2026-07-01T00:00:00.000Z',
    addedAt: '2026-07-02T00:00:00.000Z',
    mediaExt: null,
    sizeBytes: null,
    checksumSha256: null,
    width: null,
    height: null,
    sourceDurationSeconds: null,
    ...over,
  };
}

function detail(
  over: Partial<VideoDetailResponse> = {},
  video: Partial<VideoDto> = {},
): VideoDetailResponse {
  return {
    video: videoDto(video),
    channelTitle: 'A channel',
    description: null,
    activeDownloadJobId: null,
    activeDownloadStatus: null as JobStatus | null,
    events: [],
    ...over,
  };
}

function progressFrame(jobId: string, over: Partial<JobProgressPayload> = {}): SseEvent {
  return {
    type: 'job.progress',
    payload: {
      jobId,
      videoId: 'v1',
      pct: 42,
      downloadedBytes: 100,
      totalBytes: 200,
      speedBps: 10,
      etaSeconds: 30,
      currentFile: null,
      ...over,
    },
  };
}

function makeSse(): { client: SseClientLike & { close: () => void }; emit: (e: SseEvent) => void } {
  const handlers = new Set<(e: SseEvent) => void>();
  return {
    client: {
      subscribe(h) {
        handlers.add(h);
        return () => handlers.delete(h);
      },
      close() {},
    },
    emit: (e) => act(() => handlers.forEach((h) => h(e))),
  };
}

function render(id = 'v1'): {
  result: { current: ReturnType<typeof useVideo> };
  emit: (e: SseEvent) => void;
} {
  const { client, emit } = makeSse();
  const wrapper = ({ children }: { children: React.ReactNode }): React.ReactElement => (
    <SseProvider createClient={() => client}>{children}</SseProvider>
  );
  const hook = renderHook(() => useVideo(id), { wrapper });
  return { result: hook.result, emit };
}

beforeEach(() => {
  api.getVideoDetail.mockResolvedValue(detail());
  api.getSubtitles.mockResolvedValue({ subtitles: [{ lang: 'en', format: 'vtt' }] });
});
afterEach(() => vi.clearAllMocks());

describe('useVideo — load', () => {
  it('loads the detail + subtitles and clears loading', async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.detail?.channelTitle).toBe('A channel');
    expect(result.current.subtitles).toHaveLength(1);
    expect(api.getVideoDetail).toHaveBeenCalledWith('v1');
    expect(api.getSubtitles).toHaveBeenCalledWith('v1');
  });

  it('flags notFound when the detail resolves null (404 → page redirects)', async () => {
    api.getVideoDetail.mockResolvedValue(null);
    const { result } = render();
    await waitFor(() => expect(result.current.notFound).toBe(true));
    expect(result.current.detail).toBeNull();
  });

  it('surfaces an error when the detail load rejects', async () => {
    api.getVideoDetail.mockRejectedValueOnce(new Error('boom'));
    const { result } = render();
    await waitFor(() => expect(result.current.error).toBe(true));
  });

  it('keeps the video loaded when only the subtitle probe fails (non-fatal)', async () => {
    api.getSubtitles.mockRejectedValueOnce(new Error('subs blip'));
    const { result } = render();
    await waitFor(() => expect(result.current.detail?.channelTitle).toBe('A channel'));
    expect(result.current.error).toBe(false);
    expect(result.current.subtitles).toEqual([]);
  });
});

describe('useVideo — realtime (§9)', () => {
  it('video.changed (this id) patches the 2-axis badges immediately + refetches', async () => {
    const { result, emit } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const calls = api.getVideoDetail.mock.calls.length;
    api.getVideoDetail.mockResolvedValue(
      detail({}, { copyState: 'HEALTHY', sourceState: 'DELETED' }),
    );

    emit({
      type: 'video.changed',
      payload: { videoId: 'v1', channelId: 'UC1', copyState: 'HEALTHY', sourceState: 'DELETED' },
    });
    // Patched synchronously (before the debounced refetch lands).
    expect(result.current.detail?.video.copyState).toBe('HEALTHY');
    expect(result.current.detail?.video.sourceState).toBe('DELETED');
    // ...and a refetch is scheduled to reconcile the trail + active fields.
    await waitFor(() => expect(api.getVideoDetail.mock.calls.length).toBe(calls + 1));
  });

  it('ignores a video.changed for a different id', async () => {
    const { result, emit } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    emit({
      type: 'video.changed',
      payload: {
        videoId: 'other',
        channelId: 'UC1',
        copyState: 'FAILED',
        sourceState: 'AVAILABLE',
      },
    });
    expect(result.current.detail?.video.copyState).toBe('DOWNLOADING'); // unchanged
  });

  it('job.progress (the active job) patches the progress readout; ignores others', async () => {
    api.getVideoDetail.mockResolvedValue(
      detail({ activeDownloadJobId: 'job1', activeDownloadStatus: 'RUNNING' }),
    );
    const { result, emit } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));

    emit(progressFrame('job1', { pct: 77 }));
    expect(result.current.progress?.pct).toBe(77);

    emit(progressFrame('other', { pct: 5 }));
    expect(result.current.progress?.pct).toBe(77); // unchanged — not the active job
  });

  it('job.changed (active job, non-terminal) tracks the status + clears any pending', async () => {
    api.getVideoDetail.mockResolvedValue(
      detail({ activeDownloadJobId: 'job1', activeDownloadStatus: 'RUNNING' }),
    );
    const { result, emit } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.markControlPending('pausing'));

    emit({
      type: 'job.changed',
      payload: {
        jobId: 'job1',
        type: 'DOWNLOAD',
        status: 'PAUSED',
        videoId: 'v1',
        errorKind: null,
      },
    });
    expect(result.current.detail?.activeDownloadStatus).toBe('PAUSED');
    expect(result.current.controlPending).toBeUndefined();
  });

  it('job.changed (active job, terminal) refetches to reflect the new copy state', async () => {
    api.getVideoDetail.mockResolvedValue(
      detail({ activeDownloadJobId: 'job1', activeDownloadStatus: 'RUNNING' }),
    );
    const { result, emit } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const calls = api.getVideoDetail.mock.calls.length;

    emit({
      type: 'job.changed',
      payload: {
        jobId: 'job1',
        type: 'DOWNLOAD',
        status: 'COMPLETED',
        videoId: 'v1',
        errorKind: null,
      },
    });
    await waitFor(() => expect(api.getVideoDetail.mock.calls.length).toBe(calls + 1));
  });

  it('job.changed (terminal) clears the progress readout + drops the active-download reference', async () => {
    api.getVideoDetail.mockResolvedValue(
      detail({ activeDownloadJobId: 'job1', activeDownloadStatus: 'RUNNING' }),
    );
    const { result, emit } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    emit(progressFrame('job1', { pct: 88 }));
    expect(result.current.progress?.pct).toBe(88);
    // the reconciling refetch reflects the terminal outcome (job cleared, copy healthy)
    api.getVideoDetail.mockResolvedValue(detail({}, { copyState: 'HEALTHY' }));

    emit({
      type: 'job.changed',
      payload: {
        jobId: 'job1',
        type: 'DOWNLOAD',
        status: 'CANCELED',
        videoId: 'v1',
        errorKind: null,
      },
    });
    // cleared the instant the job goes terminal — no lingering bar, no live control panel
    expect(result.current.progress).toBeNull();
    expect(result.current.detail?.activeDownloadJobId).toBeNull();
    expect(result.current.detail?.activeDownloadStatus).toBeNull();
  });

  it('reconnected clears the stale progress readout before refetching', async () => {
    api.getVideoDetail.mockResolvedValue(
      detail({ activeDownloadJobId: 'job1', activeDownloadStatus: 'RUNNING' }),
    );
    const { result, emit } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    emit(progressFrame('job1', { pct: 50 }));
    expect(result.current.progress?.pct).toBe(50);
    // the reconnect refetch resolves to a distinguishable detail so we can await it
    api.getVideoDetail.mockResolvedValue(
      detail(
        { activeDownloadJobId: 'job1', activeDownloadStatus: 'RUNNING' },
        { title: 'RENAMED' },
      ),
    );

    emit({ type: 'reconnected' });
    expect(result.current.progress).toBeNull(); // don't carry a stale readout across a reconnect
    // let the refetch settle (absorbs the async update inside act)
    await waitFor(() => expect(result.current.detail?.video.title).toBe('RENAMED'));
    expect(result.current.progress).toBeNull(); // still cleared — no progress frame arrived
  });

  it('reconnected refetches the whole detail', async () => {
    const { result, emit } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const calls = api.getVideoDetail.mock.calls.length;
    emit({ type: 'reconnected' });
    await waitFor(() => expect(api.getVideoDetail.mock.calls.length).toBe(calls + 1));
  });
});

describe('useVideo — optimistic control patchers', () => {
  it('markControlPending / clearControlPending toggle the pending label', async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.markControlPending('canceling'));
    expect(result.current.controlPending).toBe('canceling');
    act(() => result.current.clearControlPending());
    expect(result.current.controlPending).toBeUndefined();
  });

  it('patchActiveStatus / patchVideo optimistically update the detail', async () => {
    api.getVideoDetail.mockResolvedValue(
      detail({ activeDownloadJobId: 'job1', activeDownloadStatus: 'QUEUED' }),
    );
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.patchActiveStatus('PAUSED'));
    expect(result.current.detail?.activeDownloadStatus).toBe('PAUSED');
    act(() => result.current.patchVideo({ copyState: 'QUEUED' }));
    expect(result.current.detail?.video.copyState).toBe('QUEUED');
  });
});
