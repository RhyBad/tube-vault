/**
 * AppShell — the ONE shell. It OWNS all navigation: the canonical desktop order
 * Home·Queue·Live·Library·Channels·Storage·Notifications·Settings, and a mobile
 * layout of 5 bottom tabs + a "More" overflow sheet holding the rest. Screens
 * render only their content inside it — they never declare or reorder nav (the
 * active item is derived from the route by NavLink). The shell also owns the
 * always-on global Search, the notification Bell, the SSE indicator, the theme +
 * language controls, and the global 401 → /login redirect.
 *
 * The SSE client is injectable so tests need no EventSource; the real app gets
 * createEventsClient (reconnect + zombie guard) untouched.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';

import type { NotificationListResponse } from '@tubevault/types';

import { apiGet, setUnauthorizedHandler } from '../../lib/api';
import { useTheme, type ThemePreference } from '../../theme/theme';
import { IconButton } from '../forms/IconButton';
import { Icon, type IconName } from '../icon/Icon';
import './AppShell.css';
import { BellPopup } from './BellPopup';
import { SearchOverlay } from './SearchOverlay';
import { SseProvider, useSse } from './SseProvider';
import { SseIndicator } from './SseIndicator';
import { useSseStatus, type SseClientLike } from './useSseStatus';
import { Wordmark } from './Wordmark';

type NavLabelKey =
  | 'nav.home'
  | 'nav.queue'
  | 'nav.live'
  | 'nav.library'
  | 'nav.channels'
  | 'nav.storage'
  | 'nav.notifications'
  | 'nav.settings';

export interface NavItem {
  key: string;
  route: string;
  icon: IconName;
  labelKey: NavLabelKey;
}

/** THE canonical nav — the single source of order. Screens can't reorder this. */
export const CANONICAL_NAV: readonly NavItem[] = [
  { key: 'home', route: '/', icon: 'home', labelKey: 'nav.home' },
  { key: 'queue', route: '/queue', icon: 'queue', labelKey: 'nav.queue' },
  { key: 'live', route: '/live', icon: 'live', labelKey: 'nav.live' },
  { key: 'library', route: '/library', icon: 'library', labelKey: 'nav.library' },
  { key: 'channels', route: '/channels', icon: 'channels', labelKey: 'nav.channels' },
  { key: 'storage', route: '/storage', icon: 'storage', labelKey: 'nav.storage' },
  {
    key: 'notifications',
    route: '/notifications',
    icon: 'notifications',
    labelKey: 'nav.notifications',
  },
  { key: 'settings', route: '/settings', icon: 'settings', labelKey: 'nav.settings' },
];

/** The 5 that stay as bottom tabs on mobile; the rest fall into "More". */
const BOTTOM_KEYS: readonly string[] = ['home', 'queue', 'library', 'channels', 'settings'];

type SseClientWithClose = SseClientLike & { close: () => void };

export interface AppShellProps {
  children?: React.ReactNode;
  /** Injectable SSE client factory (jsdom has no EventSource); defaults to the real stream. */
  createSseClient?: () => SseClientWithClose;
}

function ShellControls({
  preference,
  setPreference,
  lang,
  onLang,
}: {
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
  lang: string;
  onLang: (lng: 'en' | 'ko') => void;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="tv-controls">
      <div className="tv-controls__group" role="group" aria-label={t('theme.label')}>
        <IconButton
          size="sm"
          variant="ghost"
          label={t('theme.light')}
          aria-pressed={preference === 'light'}
          onClick={() => setPreference('light')}
        >
          <Icon name="sun" size={16} />
        </IconButton>
        <IconButton
          size="sm"
          variant="ghost"
          label={t('theme.dark')}
          aria-pressed={preference === 'dark'}
          onClick={() => setPreference('dark')}
        >
          <Icon name="moon" size={16} />
        </IconButton>
      </div>
      <div className="tv-controls__group" role="group" aria-label={t('lang.label')}>
        <button
          type="button"
          className={`tv-langbtn${lang.startsWith('en') ? ' tv-langbtn--active' : ''}`}
          aria-pressed={lang.startsWith('en')}
          onClick={() => onLang('en')}
        >
          {t('lang.en')}
        </button>
        <button
          type="button"
          className={`tv-langbtn${lang.startsWith('ko') ? ' tv-langbtn--active' : ''}`}
          aria-pressed={lang.startsWith('ko')}
          onClick={() => onLang('ko')}
        >
          {t('lang.ko')}
        </button>
      </div>
    </div>
  );
}

/**
 * The shell owns the ONE SSE stream: it wraps its whole subtree (chrome + the
 * routed screen passed as `children`) in an SseProvider, so screens subscribe to
 * the SAME client via useSse() — no second EventSource. The injectable factory is
 * threaded straight through (tests supply a fake; prod gets createEventsClient).
 */
export function AppShell({ children, createSseClient }: AppShellProps): React.ReactElement {
  return (
    <SseProvider createClient={createSseClient}>
      <AppShellChrome>{children}</AppShellChrome>
    </SseProvider>
  );
}

function AppShellChrome({ children }: { children?: React.ReactNode }): React.ReactElement {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { preference, setPreference } = useTheme();
  const sse = useSse();
  const sseStatus = useSseStatus(sse);
  const [searchOpen, setSearchOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const moreSheetRef = useRef<HTMLDivElement>(null);

  // Global 401 → SPA redirect to /login; restore the default window redirect on unmount.
  useEffect(() => {
    setUnauthorizedHandler(() => navigate('/login'));
    return () => setUnauthorizedHandler(null);
  }, [navigate]);

  // Unread badge — in-app notifications are NOT on SSE, so poll (EP-27).
  const loadUnread = useCallback(() => {
    apiGet<NotificationListResponse>('/notifications?undismissed=true&limit=20')
      .then((r) => setUnread(r.notifications.length))
      .catch(() => {});
  }, []);
  useEffect(() => {
    loadUnread();
    const id = setInterval(loadUnread, 30_000);
    return () => clearInterval(id);
  }, [loadUnread]);

  // "More" sheet modal contract: focus enters on open; Esc closes.
  useEffect(() => {
    if (!moreOpen) return;
    moreSheetRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMoreOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moreOpen]);

  const onLang = (lng: 'en' | 'ko'): void => {
    void i18n.changeLanguage(lng);
  };
  const controls = (
    <ShellControls
      preference={preference}
      setPreference={setPreference}
      lang={i18n.language}
      onLang={onLang}
    />
  );

  const bottomNav = BOTTOM_KEYS.map((k) => CANONICAL_NAV.find((n) => n.key === k)).filter(
    (n): n is NavItem => n !== undefined,
  );
  const moreNav = CANONICAL_NAV.filter((n) => !BOTTOM_KEYS.includes(n.key));
  // The "More" overflow trigger is a plain <button>, so NavLink's auto-active never
  // reaches it. Mark it active when the current route lives inside the overflow.
  const isMoreActive = moreNav.some(
    (n) => location.pathname === n.route || location.pathname.startsWith(`${n.route}/`),
  );

  return (
    <div className="tv-appshell">
      <aside className="tv-sidebar">
        <div className="tv-sidebar__brand">
          <Wordmark size="sm" />
        </div>
        <nav
          className="tv-sidebar__nav"
          data-testid="sidebar-nav"
          aria-label={t('shell.nav.primary')}
        >
          {CANONICAL_NAV.map((item) => (
            <NavLink
              key={item.key}
              to={item.route}
              end={item.route === '/'}
              data-nav-key={item.key}
              className="tv-navlink"
            >
              <Icon name={item.icon} size={20} className="tv-navlink__icon" />
              <span className="tv-navlink__label">{t(item.labelKey)}</span>
            </NavLink>
          ))}
        </nav>
        <div className="tv-sidebar__foot">
          <SseIndicator status={sseStatus} />
          {controls}
        </div>
      </aside>

      <div className="tv-appshell__main">
        <header className="tv-topbar">
          <div className="tv-topbar__brand">
            <Wordmark size="sm" />
          </div>
          <button type="button" className="tv-topbar__search" onClick={() => setSearchOpen(true)}>
            <Icon name="search" size={16} />
            <span>{t('shell.search.trigger')}</span>
          </button>
          <div className="tv-topbar__actions">
            <span className="tv-topbar__sse">
              <SseIndicator status={sseStatus} />
            </span>
            <button
              type="button"
              className="tv-belltrigger"
              aria-label={t('shell.bell.open')}
              onClick={() => setBellOpen(true)}
            >
              <Icon name="bell" size={20} />
              {unread > 0 && (
                <span className="tv-belltrigger__badge tv-numeric">
                  {unread > 9 ? '9+' : unread}
                </span>
              )}
            </button>
          </div>
        </header>
        <main className="tv-content">{children}</main>
      </div>

      <nav className="tv-bottomnav" data-testid="bottom-nav" aria-label={t('shell.nav.primary')}>
        {bottomNav.map((item) => (
          <NavLink
            key={item.key}
            to={item.route}
            end={item.route === '/'}
            data-nav-key={item.key}
            className="tv-bottomnav__link"
          >
            <Icon name={item.icon} size={20} />
            <span>{t(item.labelKey)}</span>
          </NavLink>
        ))}
        <button
          type="button"
          className={`tv-bottomnav__link tv-bottomnav__more${isMoreActive ? ' active' : ''}`}
          aria-current={isMoreActive ? 'page' : undefined}
          onClick={() => setMoreOpen(true)}
        >
          <Icon name="more" size={20} />
          <span>{t('nav.more')}</span>
        </button>
      </nav>

      {moreOpen && (
        <div className="tv-moresheet" role="presentation" onClick={() => setMoreOpen(false)}>
          <div className="tv-moresheet__scrim" />
          <div
            ref={moreSheetRef}
            className="tv-moresheet__panel"
            role="dialog"
            aria-modal="true"
            aria-label={t('nav.more')}
            data-testid="more-sheet"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            {moreNav.map((item) => (
              <NavLink
                key={item.key}
                to={item.route}
                data-nav-key={item.key}
                className="tv-moresheet__link"
                onClick={() => setMoreOpen(false)}
              >
                <Icon name={item.icon} size={20} />
                <span>{t(item.labelKey)}</span>
              </NavLink>
            ))}
            <div className="tv-moresheet__controls">{controls}</div>
          </div>
        </div>
      )}

      <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} />
      <BellPopup
        open={bellOpen}
        onClose={() => {
          setBellOpen(false);
          loadUnread();
        }}
        onChanged={loadUnread}
      />
    </div>
  );
}
