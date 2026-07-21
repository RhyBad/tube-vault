/**
 * useGlobalDefaults spec (S9 P3) — Section 1's load/edit/save cycle (EP-07/08):
 * partial PATCH of changed fields only, response-driven clamp sync, dirty
 * tracking, the "Saved" flash, and an inline save error. No SSE.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SettingsDto } from '@tubevault/types';

import { ApiError } from '../../lib/api';

const sapi = vi.hoisted(() => ({ getSettings: vi.fn(), patchSettings: vi.fn() }));
vi.mock('./settings-api', () => sapi);

import { useGlobalDefaults } from './useGlobalDefaults';

const DEFAULTS: SettingsDto = {
  downloadConcurrency: 1,
  qualityCap: 'UNLIMITED',
  subtitleMode: 'BOTH',
};

beforeEach(() => {
  sapi.getSettings.mockReset();
  sapi.patchSettings.mockReset();
  sapi.getSettings.mockResolvedValue({ ...DEFAULTS });
});
afterEach(() => vi.clearAllMocks());

describe('useGlobalDefaults — load + dirty', () => {
  it('loads the singleton into the draft and starts clean', async () => {
    const { result } = renderHook(() => useGlobalDefaults());
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(result.current.draft).toEqual(DEFAULTS);
    expect(result.current.dirty).toBe(false);
  });

  it('goes dirty on an edit and clean again when reverted', async () => {
    const { result } = renderHook(() => useGlobalDefaults());
    await waitFor(() => expect(result.current.phase).toBe('ready'));

    act(() => result.current.setQualityCap('P1080'));
    expect(result.current.dirty).toBe(true);

    act(() => result.current.setQualityCap('UNLIMITED'));
    expect(result.current.dirty).toBe(false);
  });

  it('surfaces a section error and retries', async () => {
    sapi.getSettings.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useGlobalDefaults());
    await waitFor(() => expect(result.current.phase).toBe('error'));

    sapi.getSettings.mockResolvedValueOnce({ ...DEFAULTS });
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.phase).toBe('ready'));
  });
});

describe('useGlobalDefaults — save', () => {
  it('PATCHes only the changed fields and flashes Saved', async () => {
    sapi.patchSettings.mockResolvedValue({ ...DEFAULTS, subtitleMode: 'NONE' });
    const { result } = renderHook(() => useGlobalDefaults());
    await waitFor(() => expect(result.current.phase).toBe('ready'));

    act(() => result.current.setSubtitleMode('NONE'));
    act(() => result.current.save());

    await waitFor(() => expect(result.current.justSaved).toBe(true));
    expect(sapi.patchSettings).toHaveBeenCalledWith({ subtitleMode: 'NONE' });
    expect(result.current.dirty).toBe(false);
    expect(result.current.draft?.subtitleMode).toBe('NONE');
  });

  it('does nothing when there is no change', async () => {
    const { result } = renderHook(() => useGlobalDefaults());
    await waitFor(() => expect(result.current.phase).toBe('ready'));

    act(() => result.current.save());
    expect(sapi.patchSettings).not.toHaveBeenCalled();
  });

  it('syncs to the clamped value and shows the clamp notice', async () => {
    // The server clamps 4→4 normally; simulate a clamp by returning a lower value.
    sapi.patchSettings.mockResolvedValue({ ...DEFAULTS, downloadConcurrency: 4 });
    const { result } = renderHook(() => useGlobalDefaults());
    await waitFor(() => expect(result.current.phase).toBe('ready'));

    act(() => result.current.setConcurrency(5)); // over the cap (stepper normally prevents this)
    act(() => result.current.save());

    await waitFor(() => expect(result.current.clamp).toBe(4));
    expect(result.current.draft?.downloadConcurrency).toBe(4);
    // A subsequent edit dismisses the clamp notice.
    act(() => result.current.setConcurrency(2));
    expect(result.current.clamp).toBeNull();
  });

  it('shows an inline save error on a 400 without touching the draft', async () => {
    sapi.patchSettings.mockRejectedValue(new ApiError(400, 'invalid settings patch: bad'));
    const { result } = renderHook(() => useGlobalDefaults());
    await waitFor(() => expect(result.current.phase).toBe('ready'));

    act(() => result.current.setQualityCap('P720'));
    act(() => result.current.save());

    await waitFor(() => expect(result.current.saveError).toBe('invalid settings patch: bad'));
    expect(result.current.saving).toBe(false);
    expect(result.current.draft?.qualityCap).toBe('P720'); // edit preserved
  });
});
