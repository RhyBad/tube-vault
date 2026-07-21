/**
 * useGlobalDefaults — Section 1's data source: the settings singleton (EP-07)
 * with an explicit save (EP-08). Editing builds a draft; Save sends only the
 * changed fields (partial PATCH) and syncs the UI to the RESPONSE — so a value
 * the server clamped (downloadConcurrency → [1,4]) is reflected back, with a
 * one-off clamp notice. No SSE (spec §7): settings are a load/save model.
 *
 * The section is independent — its load failure surfaces its OWN error shell and
 * never blocks the notification-channels or credential sections.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { SettingsDto } from '@tubevault/types';

import { ApiError } from '../../lib/api';
import { getSettings, patchSettings } from './settings-api';
import {
  clampNotice,
  isSettingsDirty,
  settingsPatchDiff,
  type SectionPhase,
} from './settings-presentation';

export interface UseGlobalDefaultsResult {
  phase: SectionPhase;
  /** The editable working copy (null until the first load resolves). */
  draft: SettingsDto | null;
  dirty: boolean;
  saving: boolean;
  /** True after a successful save until the next edit (the "Saved" flash). */
  justSaved: boolean;
  /** The clamped concurrency value when the server adjusted what we sent, else null. */
  clamp: number | null;
  /** Inline 400 message (invalid enum/type) — normal use never triggers it. */
  saveError: string | null;
  setConcurrency: (n: number) => void;
  setQualityCap: (v: SettingsDto['qualityCap']) => void;
  setSubtitleMode: (v: SettingsDto['subtitleMode']) => void;
  save: () => void;
  retry: () => void;
}

export function useGlobalDefaults(): UseGlobalDefaultsResult {
  const [phase, setPhase] = useState<SectionPhase>('loading');
  const [data, setData] = useState<SettingsDto | null>(null);
  const [draft, setDraft] = useState<SettingsDto | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [clamp, setClamp] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const token = useRef(0);
  const load = useCallback(() => {
    const t = ++token.current;
    setPhase('loading');
    getSettings()
      .then((res) => {
        if (t !== token.current) return;
        setData(res);
        setDraft(res);
        setPhase('ready');
      })
      .catch(() => {
        if (t !== token.current) return;
        setPhase('error');
      });
  }, []);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    load();
  }, [load]);

  // Refs keep the mutators stable (empty deps) while reading fresh state.
  const dataRef = useRef(data);
  dataRef.current = data;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const savingRef = useRef(saving);
  savingRef.current = saving;

  const patchDraft = useCallback((patch: Partial<SettingsDto>) => {
    setDraft((cur) => (cur ? { ...cur, ...patch } : cur));
    // Any edit dismisses the last save's confirmation + clamp notice.
    setJustSaved(false);
    setClamp(null);
    setSaveError(null);
  }, []);

  const setConcurrency = useCallback(
    (n: number) => patchDraft({ downloadConcurrency: n }),
    [patchDraft],
  );
  const setQualityCap = useCallback(
    (v: SettingsDto['qualityCap']) => patchDraft({ qualityCap: v }),
    [patchDraft],
  );
  const setSubtitleMode = useCallback(
    (v: SettingsDto['subtitleMode']) => patchDraft({ subtitleMode: v }),
    [patchDraft],
  );

  const save = useCallback(() => {
    const cur = draftRef.current;
    const base = dataRef.current;
    if (cur === null || base === null || savingRef.current) return;
    const patch = settingsPatchDiff(cur, base);
    if (Object.keys(patch).length === 0) return; // nothing changed
    setSaving(true);
    setSaveError(null);
    patchSettings(patch)
      .then((res) => {
        setData(res);
        setDraft(res); // sync to server truth (reflects any clamp)
        setClamp(clampNotice(patch, res));
        setJustSaved(true);
        setSaving(false);
      })
      .catch((err: unknown) => {
        setSaving(false);
        setSaveError(err instanceof ApiError ? err.message : 'save failed');
      });
  }, []);

  return {
    phase,
    draft,
    dirty: data !== null && draft !== null && isSettingsDirty(draft, data),
    saving,
    justSaved,
    clamp,
    saveError,
    setConcurrency,
    setQualityCap,
    setSubtitleMode,
    save,
    retry: () => loadRef.current(),
  };
}
