/**
 * RegisterPanel — the EP-10 register widget (onboarding entry). A self-contained
 * card: it owns the url input, the busy flag, and its inline notice. Submitting
 * calls the page's `register` (the hook), then surfaces the outcome IN PLACE —
 * success/already (with links to the queue/home) or the 422/504/502/generic error
 * (danger/warning intent, a field error for a non-channel URL, a Retry for the
 * transient ones). There is NO progress bar (spec §S2): enumeration runs in the
 * background and the list's counts fill in via SSE. Errors never leave the panel;
 * the page's toast queue is for the row actions, not this.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { RegisterChannelResponse } from '@tubevault/types';

import { ApiError } from '../../lib/api';
import { Button, Icon, TextField, type IconName } from '../../ds';
import {
  registerErrorView,
  registerSuccessView,
  type NoticeIntent,
  type RegisterErrorView,
} from './channels-presentation';

export interface RegisterPanelProps {
  /** The hook's EP-10 register; resolves with the response or rejects (ApiError). */
  onRegister: (url: string) => Promise<RegisterChannelResponse>;
  /** Notice links: jump to the background progress. */
  onNavigate: (dest: 'queue' | 'home') => void;
}

type Notice =
  { type: 'ok'; already: boolean; name: string } | { type: 'err'; view: RegisterErrorView };

/** Per-error icon (the design distinguishes engine/502 from a 422 — x-octagon vs alert). */
const ERROR_ICON: Record<RegisterErrorView['kind'], IconName> = {
  notFound: 'alert',
  timeout: 'clock',
  engine: 'x-octagon',
  generic: 'alert',
};

export function RegisterPanel({ onRegister, onNavigate }: RegisterPanelProps): React.ReactElement {
  const { t } = useTranslation();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [lastUrl, setLastUrl] = useState('');

  const submit = async (raw: string): Promise<void> => {
    const trimmed = raw.trim();
    if (trimmed === '' || busy) return;
    setBusy(true);
    setNotice(null);
    setLastUrl(trimmed);
    try {
      const res = await onRegister(trimmed);
      const v = registerSuccessView(res);
      setNotice({ type: 'ok', already: v.already, name: v.name });
      setUrl('');
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setNotice({ type: 'err', view: registerErrorView(status) });
    } finally {
      setBusy(false);
    }
  };

  const fieldError =
    notice !== null && notice.type === 'err' && notice.view.field
      ? t('channels.notice.notFoundField')
      : undefined;

  const intent: NoticeIntent =
    notice === null
      ? 'info'
      : notice.type === 'ok'
        ? notice.already
          ? 'info'
          : 'success'
        : notice.view.intent;

  const noticeTitle =
    notice === null
      ? ''
      : notice.type === 'ok'
        ? t(notice.already ? 'channels.notice.alreadyTitle' : 'channels.notice.successTitle', {
            name: notice.name,
          })
        : t(`channels.notice.${notice.view.kind}Title`);

  const noticeMsg =
    notice === null
      ? ''
      : notice.type === 'ok'
        ? t(notice.already ? 'channels.notice.alreadyMsg' : 'channels.notice.successMsg')
        : t(`channels.notice.${notice.view.kind}Msg`);

  const noticeIcon: IconName =
    notice === null
      ? 'info'
      : notice.type === 'ok'
        ? notice.already
          ? 'info'
          : 'check'
        : ERROR_ICON[notice.view.kind];

  const showLinks = notice !== null && notice.type === 'ok';
  const showRetry = notice !== null && notice.type === 'err' && notice.view.retry;

  return (
    <section className="tv-chreg">
      <div className="tv-chreg__head">
        <span className="tv-chreg__badge" aria-hidden="true">
          <Icon name="plus" size={17} />
        </span>
        <div className="tv-chreg__headtext">
          <h2 className="tv-chreg__title">{t('channels.register.title')}</h2>
          <p className="tv-chreg__hint">{t('channels.register.hint')}</p>
        </div>
      </div>

      <form
        className="tv-chreg__form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(url);
        }}
      >
        <TextField
          value={url}
          onChange={(v) => {
            setUrl(v);
            if (notice !== null) setNotice(null);
          }}
          placeholder={t('channels.register.placeholder')}
          ariaLabel={t('channels.register.fieldLabel')}
          leadingIcon="globe"
          mono
          error={fieldError}
          disabled={busy}
          className="tv-chreg__field"
        />
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? t('channels.register.submitBusy') : t('channels.register.submit')}
        </Button>
      </form>

      {notice !== null && (
        <div className="tv-chreg__notice" data-intent={intent} role="status">
          <span className="tv-chreg__notice-icon" aria-hidden="true">
            <Icon name={noticeIcon} size={15} />
          </span>
          <div className="tv-chreg__notice-body">
            <span className="tv-chreg__notice-title">{noticeTitle}</span>
            <span className="tv-chreg__notice-msg">{noticeMsg}</span>
            {(showLinks || showRetry) && (
              <div className="tv-chreg__notice-links">
                {showLinks && (
                  <>
                    <button
                      type="button"
                      className="tv-chreg__link"
                      onClick={() => onNavigate('queue')}
                    >
                      {t('channels.register.viewQueue')}
                    </button>
                    <button
                      type="button"
                      className="tv-chreg__link"
                      onClick={() => onNavigate('home')}
                    >
                      {t('channels.register.viewHome')}
                    </button>
                  </>
                )}
                {showRetry && (
                  <button
                    type="button"
                    className="tv-chreg__link tv-chreg__link--retry"
                    onClick={() => void submit(lastUrl)}
                  >
                    <Icon name="retry" size={13} />
                    {t('channels.register.retry')}
                  </button>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            className="tv-chreg__notice-x"
            aria-label={t('channels.register.dismiss')}
            onClick={() => setNotice(null)}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
    </section>
  );
}
