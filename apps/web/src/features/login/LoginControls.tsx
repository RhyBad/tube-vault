/**
 * LoginControls — the login-local theme + language cluster (top-right of the
 * pre-auth screen, where there is no app shell to host them). It reuses the same
 * primitives the shell does — `useTheme`/`setPreference` (the 'system' sentinel
 * stays the default until the user picks) and `i18n`/`setLanguage` — so a choice
 * made here persists and carries straight into the authed app.
 *
 * The theme control is a single toggle (the design's compact form): it flips the
 * RESOLVED theme, detaching from 'system' on first use, exactly like the design.
 */
import { useTranslation } from 'react-i18next';

import { IconButton } from '../../ds/forms/IconButton';
import { Icon } from '../../ds/icon/Icon';
import { setLanguage, type Language } from '../../i18n';
import { useTheme } from '../../theme/theme';

export function LoginControls(): React.ReactElement {
  const { t, i18n } = useTranslation();
  const { resolved, setPreference } = useTheme();
  const isDark = resolved === 'dark';

  const onLang = (lng: Language): void => {
    void setLanguage(lng);
  };

  return (
    <div className="tv-login__controls">
      <div className="tv-login__seg" role="group" aria-label={t('login.lang.group')}>
        <button
          type="button"
          className={`tv-login__segbtn${i18n.language.startsWith('en') ? ' is-active' : ''}`}
          aria-pressed={i18n.language.startsWith('en')}
          onClick={() => onLang('en')}
        >
          {t('login.lang.en')}
        </button>
        <button
          type="button"
          className={`tv-login__segbtn${i18n.language.startsWith('ko') ? ' is-active' : ''}`}
          aria-pressed={i18n.language.startsWith('ko')}
          onClick={() => onLang('ko')}
        >
          {t('login.lang.ko')}
        </button>
      </div>
      <IconButton
        size="sm"
        variant="ghost"
        label={isDark ? t('login.theme.toLight') : t('login.theme.toDark')}
        onClick={() => setPreference(isDark ? 'light' : 'dark')}
      >
        <Icon name={isDark ? 'sun' : 'moon'} size={16} />
      </IconButton>
    </div>
  );
}
