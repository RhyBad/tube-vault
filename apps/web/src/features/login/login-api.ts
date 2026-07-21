/**
 * login-api — the @Public() login verb S0 talks to (EP-02), layered on the
 * shared lib/api fetch wrapper. There is no `@tubevault/types` auth DTO (the
 * controller reads `{ secret }` manually and answers `{ ok: true }`), so the
 * shape is typed locally here.
 *
 * The login POST opts OUT of the wrapper's global 401 → /login redirect
 * (`redirectOn401: false`) so a wrong secret surfaces as a displayable ApiError
 * on this very page instead of triggering a reload loop.
 *
 * EP-03 (logout) now lives in `lib/session.signOut` — Settings' Session/account
 * affordance (Decision 1) is the only caller, so it owns the binding alongside
 * the local login-time bookkeeping it must clear on sign-out.
 */
import { apiPost } from '../../lib/api';

export interface AuthResult {
  ok: boolean;
}

/** EP-02 — exchange the shared secret for the signed `tv_session` cookie. */
export function apiLogin(secret: string): Promise<AuthResult> {
  return apiPost<AuthResult>('/auth/login', { secret }, { redirectOn401: false });
}
