/**
 * SessionSection — Settings' "Session / account" affordance (Decision 1). Unlike
 * the other three sections it is NOT wired to a backend (there is no
 * session-status GET endpoint — the `tv_session` cookie is stateless + httpOnly),
 * so it skips SettingsSectionCard entirely: no "NN / 03" index, no EP chip, just
 * the shared `.tv-set__section` card chrome. It reads the client-recorded login
 * time itself (lib/session) to derive an expiry readout, falling back to a
 * static TTL note when nothing is recorded. Purely presentational — no toasts,
 * no navigation; the page owns both via `onSignOut`.
 */
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../ds';
import { formatRelativeTime } from '../../i18n/format';
import { getLoginAt, SESSION_TTL_MS } from '../../lib/session';
import { APP_VERSION } from '../../lib/version';
import './SettingsPage.css';

export interface SessionSectionProps {
  onSignOut: () => void;
}

export function SessionSection({ onSignOut }: SessionSectionProps): React.ReactElement {
  const { t, i18n } = useTranslation();
  const titleId = useId();

  const loginAt = getLoginAt();
  const statusLine =
    loginAt !== null
      ? t('settings.session.expiresAt', {
          time: formatRelativeTime(new Date(loginAt + SESSION_TTL_MS).toISOString(), i18n.language),
        })
      : t('settings.session.ttlNote');

  return (
    <section className="tv-set__section" aria-labelledby={titleId}>
      <header className="tv-set__head">
        <div className="tv-set__head-main">
          <h2 id={titleId} className="tv-set__title">
            {t('settings.session.title')}
          </h2>
          <p className="tv-set__desc">{t('settings.session.desc')}</p>
        </div>
      </header>

      <div className="tv-set-session__body">
        <span className="tv-set-session__status">{statusLine}</span>
        <Button variant="secondary" onClick={onSignOut}>
          {t('settings.session.signOut')}
        </Button>
      </div>
      <p className="tv-set-session__version">
        {t('settings.session.version', { version: APP_VERSION })}
      </p>
    </section>
  );
}
