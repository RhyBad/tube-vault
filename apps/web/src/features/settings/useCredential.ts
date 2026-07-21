/**
 * useCredential — Section 3's data source (EP-04/05/06): the owner's YouTube
 * cookie credential STATUS (never the cookie itself). A load/save model (no SSE):
 * import (PUT) and delete (DELETE) return the fresh status, which re-derives the
 * view. The feature can be OFF (no TUBEVAULT_CREDENTIAL_KEY_FILE) — GET still
 * answers `enabled:false` so the section renders the 503 setup hint instead of an
 * error; import/delete are simply not offered in that state.
 *
 * Independent section (spec §6): its own load failure never blocks the others.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { SessionStatusResponse } from '@tubevault/types';

import { deleteSession, getSessionStatus, importCookies as apiImportCookies } from './settings-api';
import {
  deriveCredentialView,
  type CredentialView,
  type SectionPhase,
} from './settings-presentation';

export interface UseCredentialResult {
  phase: SectionPhase;
  view: CredentialView | null;
  importing: boolean;
  retry: () => void;
  /** EP-05 — import a Netscape cookie jar; refreshes status to UNVERIFIED. */
  importCookies: (cookies: string) => Promise<void>;
  /** EP-06 — forget the stored cookie. */
  remove: () => Promise<void>;
}

export function useCredential(): UseCredentialResult {
  const [phase, setPhase] = useState<SectionPhase>('loading');
  const [session, setSession] = useState<SessionStatusResponse | null>(null);
  const [importing, setImporting] = useState(false);

  const token = useRef(0);
  const load = useCallback(() => {
    const t = ++token.current;
    setPhase('loading');
    getSessionStatus()
      .then((res) => {
        if (t !== token.current) return;
        setSession(res);
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

  const importCookies = useCallback(async (cookies: string) => {
    setImporting(true);
    try {
      const res = await apiImportCookies(cookies);
      setSession(res); // fresh status (UNVERIFIED) — re-derives the view
    } finally {
      setImporting(false);
    }
  }, []);

  const remove = useCallback(async () => {
    const res = await deleteSession();
    setSession(res); // configured:false
  }, []);

  return {
    phase,
    view: session !== null ? deriveCredentialView(session) : null,
    importing,
    retry: () => loadRef.current(),
    importCookies,
    remove,
  };
}
