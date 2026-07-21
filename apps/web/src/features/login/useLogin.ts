/**
 * useLogin — S0's state machine for the shared-secret exchange (EP-02). It
 * mirrors the settings hooks' shape (explicit status + stable mutators over
 * refs) but models a one-shot credential submit rather than a load/save cycle:
 *
 *  - submit() drives apiLogin and maps each ApiError to a STABLE errorKind so
 *    the view never parses server prose (401→invalid, 429→rate, 400/413→
 *    malformed, anything else→generic).
 *  - 429 has no Retry-After, so we seed a FIXED client-side 60s cooldown and
 *    tick it down once a second; submit stays disabled until it reaches 0, at
 *    which point the error clears back to idle.
 *  - a clean login records the login time (lib/session — there is no session
 *    GET endpoint, so Settings' expiry readout derives it client-side from this
 *    + the known TTL) and then calls onSuccess (the page navigates to '/').
 *
 * Editing the secret optimistically clears a stale non-rate error (a rate error
 * persists — it is gated by the cooldown, not by the input).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../../lib/api';
import { recordLoginAt } from '../../lib/session';
import { apiLogin } from './login-api';

export type LoginStatus = 'idle' | 'submitting' | 'error';
export type LoginErrorKind = 'invalid' | 'rate' | 'malformed' | 'generic';

/** Fixed client-side lockout after a 429 (no Retry-After header exists). */
export const RATE_COOLDOWN_SECONDS = 60;

export interface UseLoginOptions {
  onSuccess: () => void;
}

export interface UseLoginResult {
  secret: string;
  status: LoginStatus;
  errorKind: LoginErrorKind | null;
  /** Seconds remaining on the 429 lockout; 0 when not rate-limited. */
  cooldown: number;
  /** submitting || secret==='' || cooldown>0 */
  loginDisabled: boolean;
  setSecret: (value: string) => void;
  submit: () => void;
}

function kindForError(err: unknown): LoginErrorKind {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'invalid';
    if (err.status === 429) return 'rate';
    if (err.status === 400 || err.status === 413) return 'malformed';
  }
  return 'generic';
}

export function useLogin({ onSuccess }: UseLoginOptions): UseLoginResult {
  const [secret, setSecretState] = useState('');
  const [status, setStatus] = useState<LoginStatus>('idle');
  const [errorKind, setErrorKind] = useState<LoginErrorKind | null>(null);
  const [cooldown, setCooldown] = useState(0);

  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);
  useEffect(() => clearTimer, [clearTimer]);

  const startCooldown = useCallback(() => {
    clearTimer();
    setCooldown(RATE_COOLDOWN_SECONDS);
    timer.current = setInterval(() => {
      setCooldown((c) => {
        if (c <= 1) {
          clearTimer();
          // The lockout is over — return the form to a clean idle state.
          setStatus('idle');
          setErrorKind(null);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  }, [clearTimer]);

  const setSecret = useCallback((value: string) => {
    setSecretState(value);
    // Dismiss a stale error as the user retypes — but never a rate error, which
    // the cooldown owns until it elapses.
    setErrorKind((kind) => {
      if (kind !== null && kind !== 'rate') {
        setStatus('idle');
        return null;
      }
      return kind;
    });
  }, []);

  // Refs keep submit() stable while it reads the freshest state.
  const secretRef = useRef(secret);
  secretRef.current = secret;
  const statusRef = useRef(status);
  statusRef.current = status;
  const cooldownRef = useRef(cooldown);
  cooldownRef.current = cooldown;

  const submit = useCallback(() => {
    const value = secretRef.current;
    if (statusRef.current === 'submitting' || value === '' || cooldownRef.current > 0) return;
    setStatus('submitting');
    setErrorKind(null);
    apiLogin(value)
      .then(() => {
        recordLoginAt();
        onSuccess();
      })
      .catch((err: unknown) => {
        const kind = kindForError(err);
        setErrorKind(kind);
        setStatus('error');
        if (kind === 'rate') startCooldown();
      });
  }, [onSuccess, startCooldown]);

  return {
    secret,
    status,
    errorKind,
    cooldown,
    loginDisabled: status === 'submitting' || secret === '' || cooldown > 0,
    setSecret,
    submit,
  };
}
