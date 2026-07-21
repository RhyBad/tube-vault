/**
 * LoginView — S0's pure presentation. Every value is injected (secret, status,
 * errorKind, cooldown, disabled + the two callbacks); it holds only view-local
 * UI state (reveal + caps-lock), never data or navigation. The secret field is
 * the DS `TextField`, with the reveal-eye IconButton in its `trailing` slot; it
 * is labelled + aria-invalid on a danger error for free. Button is reused from
 * the DS.
 *
 * Error surfacing splits by kind: invalid / malformed / generic are true field
 * errors (shown inline via TextField's `error`, which sets aria-invalid); the
 * 429 `rate` limit is a transient WARNING, not a bad field, so it renders as its
 * own alert line with the client-side m:ss countdown and leaves the field valid.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../ds/forms/Button';
import { IconButton } from '../../ds/forms/IconButton';
import { TextField } from '../../ds/forms/TextField';
import { Icon } from '../../ds/icon/Icon';
import { Wordmark } from '../../ds/shell/Wordmark';
import { LoginControls } from './LoginControls';
import type { LoginErrorKind, LoginStatus } from './useLogin';
import './LoginView.css';

export interface LoginViewProps {
  secret: string;
  status: LoginStatus;
  errorKind: LoginErrorKind | null;
  cooldown: number;
  loginDisabled: boolean;
  onSecretChange: (value: string) => void;
  onSubmit: () => void;
}

/** Whole-seconds clock, e.g. 47 → "0:47", 60 → "1:00". */
function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const DANGER_KINDS: readonly LoginErrorKind[] = ['invalid', 'malformed', 'generic'];

export function LoginView({
  secret,
  status,
  errorKind,
  cooldown,
  loginDisabled,
  onSecretChange,
  onSubmit,
}: LoginViewProps): React.ReactElement {
  const { t } = useTranslation();
  const [reveal, setReveal] = useState(false);
  const [capsOn, setCapsOn] = useState(false);

  const submitting = status === 'submitting';
  const isRate = errorKind === 'rate';
  const dangerError =
    errorKind !== null && DANGER_KINDS.includes(errorKind)
      ? t(`login.error.${errorKind}`)
      : undefined;

  const onSubmitForm = (e: React.FormEvent): void => {
    e.preventDefault();
    onSubmit();
  };

  // Caps Lock is only knowable from a keyboard event's modifier state.
  const onKeyUp = (e: React.KeyboardEvent): void => {
    setCapsOn(e.getModifierState('CapsLock'));
  };

  return (
    <div className="tv-login">
      <LoginControls />

      <div className="tv-login__stack">
        <div className="tv-login__card" data-screen-label="S0 · Login">
          <div className="tv-login__brand">
            <Wordmark size="lg" />
          </div>

          <p className="tv-login__lead">{t('login.lead')}</p>

          <form className="tv-login__form" onSubmit={onSubmitForm} onKeyUp={onKeyUp}>
            {/* `errorLive` makes ONLY the field's error hint an assertive live
                region, so the danger error (invalid / malformed / generic) — shown
                inline via the red hint and otherwise read only on focus — is
                announced the moment it appears. Scoped to the hint text, so the
                label, input, and the reveal-eye control stay out of the live region
                (their changes aren't announced). The 429 rate warning has its own
                role=alert line below and is unaffected. */}
            <TextField
              label={t('login.secretLabel')}
              value={secret}
              onChange={onSecretChange}
              type={reveal ? 'text' : 'password'}
              placeholder={t('login.placeholder')}
              error={dangerError}
              errorLive
              mono
              spellCheck={false}
              autoFocus
              autoComplete="current-password"
              trailing={
                <IconButton
                  size="sm"
                  variant="ghost"
                  label={reveal ? t('login.hide') : t('login.reveal')}
                  onClick={() => setReveal((v) => !v)}
                >
                  <Icon name={reveal ? 'eye-off' : 'eye'} size={16} />
                </IconButton>
              }
            />

            {capsOn && (
              <p className="tv-login__caps" role="status">
                <Icon name="alert" size={13} aria-hidden />
                {t('login.capsHint')}
              </p>
            )}

            {isRate && (
              <div className="tv-login__rate" role="alert">
                <Icon name="alert" size={14} aria-hidden />
                <span>
                  {t('login.error.rate')}
                  {cooldown > 0 && (
                    // aria-hidden: role="alert" is assertive + atomic, so the per-second
                    // tick would re-announce the whole alert for the ~60s lockout. The
                    // disabled submit + visible clock already convey it visually.
                    <span className="tv-login__cooldown" aria-hidden="true">
                      {' '}
                      {t('login.cooldown', { time: formatClock(cooldown) })}
                    </span>
                  )}
                </span>
              </div>
            )}

            <Button type="submit" size="lg" fullWidth disabled={loginDisabled}>
              {submitting ? (
                <span className="tv-login__busy">
                  <Icon name="loader" size={15} className="tv-login__spin" aria-hidden />
                  {t('login.busy')}
                </span>
              ) : (
                t('login.submit')
              )}
            </Button>
          </form>
        </div>

        <p className="tv-login__footer">
          <Icon name="lock" size={13} aria-hidden />
          {t('login.footer')}
        </p>
      </div>
    </div>
  );
}
