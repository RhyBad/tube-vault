/**
 * useNotificationChannels — Section 2's data source (EP-29..33). A load/save model
 * (no SSE, spec §7): every mutation re-reads the list so the UI reflects the
 * server (secrets stay masked, createdAt-asc order stays authoritative). The hook
 * owns the per-row test lifecycle (in-flight set + last result); the caller (page)
 * owns the toasts + the delete confirm. Mutators reject with ApiError so the
 * caller can branch (400 → inline field errors, 404 → refetch + toast).
 *
 * This section is independent — its own load failure surfaces its OWN error shell
 * and never blocks the defaults or credential sections (spec §6).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  CreateNotificationChannelRequest,
  NotificationChannelDto,
  UpdateNotificationChannelRequest,
} from '@tubevault/types';

import { ApiError } from '../../lib/api';
import {
  createNotificationChannel,
  deleteNotificationChannel,
  getNotificationChannels,
  patchNotificationChannel,
  testNotificationChannel,
} from './settings-api';
import { testResultView, type SectionPhase, type TestResultView } from './settings-presentation';

export interface UseNotificationChannelsResult {
  phase: SectionPhase;
  channels: NotificationChannelDto[];
  retry: () => void;
  /** POST a new channel, then refetch. Rejects (ApiError) on a bad config. */
  create: (body: CreateNotificationChannelRequest) => Promise<void>;
  /** PATCH a channel (keep-secret merge), then refetch. Rejects on 400/404. */
  update: (id: string, body: UpdateNotificationChannelRequest) => Promise<void>;
  /** DELETE a channel, then refetch. Rejects on 404 (already gone). */
  remove: (id: string) => Promise<void>;
  /** Optimistic enabled toggle; reverts + rejects on failure. */
  toggleEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Fire a REAL test send; stores the (neutral) result. Rejects only on 404/etc. */
  runTest: (id: string) => Promise<void>;
  /** Ids with a test send in flight (spinner + disabled button). */
  testing: ReadonlySet<string>;
  /** The last test result per channel id (delivered:false is a result, not error). */
  results: Readonly<Record<string, TestResultView>>;
  /** Clear the shown test result for a channel (e.g. when its edit panel opens). */
  clearResult: (id: string) => void;
}

export function useNotificationChannels(): UseNotificationChannelsResult {
  const [phase, setPhase] = useState<SectionPhase>('loading');
  const [channels, setChannels] = useState<NotificationChannelDto[]>([]);
  const [testing, setTesting] = useState<ReadonlySet<string>>(() => new Set());
  const [results, setResults] = useState<Record<string, TestResultView>>({});

  const channelsRef = useRef<NotificationChannelDto[]>(channels);
  channelsRef.current = channels;
  const token = useRef(0);

  /** `quiet` skips the skeleton (a post-mutation refetch shouldn't flash). */
  const load = useCallback((quiet: boolean) => {
    const t = ++token.current;
    if (!quiet) setPhase('loading');
    return getNotificationChannels()
      .then((res) => {
        if (t !== token.current) return;
        setChannels(res.channels);
        setPhase('ready');
      })
      .catch(() => {
        if (t !== token.current) return;
        // A quiet refetch failure PRESERVES the shown list (no false wipe).
        if (!quiet) setPhase('error');
      });
  }, []);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    load(false);
  }, [load]);

  const create = useCallback(async (body: CreateNotificationChannelRequest) => {
    await createNotificationChannel(body);
    await loadRef.current(true);
  }, []);

  const update = useCallback(async (id: string, body: UpdateNotificationChannelRequest) => {
    try {
      await patchNotificationChannel(id, body);
      await loadRef.current(true);
    } catch (err) {
      // A 404 means it vanished under us — refetch so the list stays honest.
      if (err instanceof ApiError && err.status === 404) await loadRef.current(true);
      throw err;
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    try {
      await deleteNotificationChannel(id);
      await loadRef.current(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) await loadRef.current(true);
      throw err;
    }
  }, []);

  const toggleEnabled = useCallback(async (id: string, enabled: boolean) => {
    const prev = channelsRef.current;
    // Optimistic flip so the switch feels instant.
    setChannels(prev.map((c) => (c.id === id ? { ...c, enabled } : c)));
    try {
      const updated = await patchNotificationChannel(id, { enabled });
      setChannels((cur) => cur.map((c) => (c.id === id ? updated : c)));
    } catch (err) {
      setChannels(prev); // revert to server truth
      if (err instanceof ApiError && err.status === 404) {
        setChannels((cur) => cur.filter((c) => c.id !== id));
      }
      throw err;
    }
  }, []);

  const runTest = useCallback(async (id: string) => {
    setTesting((cur) => new Set(cur).add(id));
    setResults((cur) => {
      const next = { ...cur };
      delete next[id];
      return next;
    });
    try {
      const res = await testNotificationChannel(id);
      setResults((cur) => ({ ...cur, [id]: testResultView(res) }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) await loadRef.current(true);
      throw err; // the page toasts (a non-200 is a real error, unlike delivered:false)
    } finally {
      setTesting((cur) => {
        const next = new Set(cur);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const clearResult = useCallback((id: string) => {
    setResults((cur) => {
      if (!(id in cur)) return cur;
      const next = { ...cur };
      delete next[id];
      return next;
    });
  }, []);

  return {
    phase,
    channels,
    retry: () => loadRef.current(false),
    create,
    update,
    remove,
    toggleEnabled,
    runTest,
    testing,
    results,
    clearResult,
  };
}
