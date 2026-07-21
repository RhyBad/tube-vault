/**
 * CredentialSection — Section 3's view (EP-04/05/06). The health row (status pill
 * + last-verified / failure-streak / last-error), the disabled 503 setup banner,
 * the expired warning with the S7 Live cross-link, the unverified note, and the
 * write-only import form (paste a Netscape cookie jar, ≤1 MiB, reveal + choose-
 * file). The cookie is never read back — importing resets status to UNVERIFIED.
 */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '../../lib/api';
import { Button, Icon, type ToastIntent } from '../../ds';
import { formatRelativeTime } from '../../i18n/format';
import { CredentialStatusPill } from './CredentialStatusPill';
import { SettingsSectionCard } from './SettingsSectionCard';
import type { UseCredentialResult } from './useCredential';

/** EP-05 caps the cookie jar at 1 MiB — guard client-side so paste/file match. */
const MAX_COOKIE_CHARS = 1_048_576;

export interface CredentialSectionProps {
  index: number;
  credential: UseCredentialResult;
  onToast: (intent: ToastIntent, title: string, message?: string) => void;
  onRequestDelete: () => void;
  /** Cross-link to S7 Live (expired credential → members-only lives won't capture). */
  onGoLive: () => void;
}

export function CredentialSection({
  index,
  credential,
  onToast,
  onRequestDelete,
  onGoLive,
}: CredentialSectionProps): React.ReactElement {
  const { t, i18n } = useTranslation();
  const [importVal, setImportVal] = useState('');
  const [reveal, setReveal] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const view = credential.view;
  const disabled = view?.disabled ?? false;

  const handleImport = (): void => {
    if (disabled || importVal === '') return;
    credential
      .importCookies(importVal)
      .then(() => {
        setImportVal('');
        setReveal(false);
        onToast('success', t('settings.cred.toast.imported'), t('settings.cred.willVerify'));
      })
      .catch((err: unknown) => {
        onToast(
          'danger',
          t('feedback.error.title'),
          err instanceof ApiError ? err.message : undefined,
        );
      });
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (file === undefined) return;
    // A failed read (file removed/renamed between pick and read, permissions) must
    // surface, not become an unhandled rejection.
    file
      .text()
      .then((text) => setImportVal(text.slice(0, MAX_COOKIE_CHARS)))
      .catch(() => onToast('danger', t('feedback.error.title')));
  };

  return (
    <SettingsSectionCard
      index={index}
      eyebrow={t('settings.cred.eyebrow')}
      title={t('settings.cred.title')}
      description={t('settings.cred.desc')}
      epLabel={t('settings.cred.ep')}
      phase={credential.phase}
      onRetry={credential.retry}
    >
      {view !== null && (
        <div className="tv-set-cred">
          {/* health row */}
          <div className="tv-set-cred__health">
            {view.showBadge && view.status !== null && (
              <CredentialStatusPill
                intent={view.badgeIntent}
                label={t(`settings.cred.status.${view.status}`)}
              />
            )}
            {disabled && (
              <CredentialStatusPill intent="muted" label={t('settings.cred.status.disabled')} />
            )}
            <div className="tv-set-cred__stat">
              <span className="tv-set-cred__stat-label">
                {t('settings.cred.health.lastVerified')}
              </span>
              <span className="tv-set-cred__stat-value tv-numeric">
                {formatRelativeTime(view.lastVerifiedAt, i18n.language)}
              </span>
            </div>
            <div className="tv-set-cred__stat">
              <span className="tv-set-cred__stat-label">
                {t('settings.cred.health.failureStreak')}
              </span>
              <span className="tv-set-cred__stat-value tv-numeric" data-intent={view.streakIntent}>
                {view.failureStreak}
              </span>
            </div>
            <div className="tv-set-cred__stat tv-set-cred__stat--wide">
              <span className="tv-set-cred__stat-label">{t('settings.cred.health.lastError')}</span>
              <span className="tv-set-cred__stat-value tv-set-cred__stat-value--mono">
                {view.lastError ?? t('settings.cred.health.none')}
              </span>
            </div>
          </div>

          {/* disabled 503 setup banner */}
          {disabled && (
            <div className="tv-set-cred__banner">
              <span className="tv-set-cred__banner-icon">
                <Icon name="lock" size={16} />
              </span>
              <div className="tv-set-cred__banner-body">
                <span className="tv-set-cred__banner-title">
                  {t('settings.cred.disabled.title')}
                </span>
                <span className="tv-set-cred__banner-desc">{t('settings.cred.disabled.desc')}</span>
              </div>
            </div>
          )}

          {/* expired warning + cross-link */}
          {view.expired && (
            <div className="tv-set-cred__warn" role="alert">
              <Icon name="alert" size={18} className="tv-set-cred__warn-icon" />
              <div className="tv-set-cred__warn-body">
                <span>{t('settings.cred.expired.warn')}</span>
                <button type="button" className="tv-set-cred__crosslink" onClick={onGoLive}>
                  {t('settings.cred.expired.goLive')}
                  <Icon name="arrow-right" size={13} />
                </button>
              </div>
            </div>
          )}

          {/* unverified note */}
          {view.unverified && (
            <div className="tv-set-cred__note" role="status">
              <span className="tv-set-cred__note-dot" aria-hidden="true" />
              <span>{t('settings.cred.willVerify')}</span>
            </div>
          )}

          {/* import form */}
          <div className="tv-set-cred__import">
            <div className="tv-set-cred__importhead">
              <span className="tv-set-field__label">{t('settings.cred.import.label')}</span>
              <div className="tv-set-cred__importhead-right">
                {importVal !== '' && (
                  <span className="tv-set-cred__size tv-numeric">
                    {/* §S9-9: echo the 1 MiB cap as you paste, not a bare char count. */}
                    {t('settings.cred.import.budget', {
                      kb: (importVal.length / 1024).toFixed(1),
                    })}
                  </span>
                )}
                <button
                  type="button"
                  className="tv-set-cred__linkbtn"
                  onClick={() => setReveal((r) => !r)}
                  disabled={disabled}
                >
                  {reveal ? t('settings.cred.import.hide') : t('settings.cred.import.reveal')}
                </button>
              </div>
            </div>

            <textarea
              className="tv-set-cred__textarea"
              value={importVal}
              onChange={(e) => setImportVal(e.target.value.slice(0, MAX_COOKIE_CHARS))}
              placeholder={t('settings.cred.import.placeholder')}
              disabled={disabled}
              spellCheck={false}
              data-reveal={reveal}
              aria-label={t('settings.cred.import.label')}
            />
            <span className="tv-set-field__hint">{t('settings.cred.import.hint')}</span>

            <div className="tv-set-cred__importfoot">
              <Button
                variant="primary"
                icon="arrow-down-to-line"
                onClick={handleImport}
                disabled={disabled || importVal === '' || credential.importing}
              >
                {credential.importing
                  ? t('settings.cred.import.importing')
                  : t('settings.cred.import.button')}
              </Button>
              <button
                type="button"
                className="tv-set-cred__file"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled}
              >
                <Icon name="arrow-up-to-line" size={14} />
                {t('settings.cred.import.chooseFile')}
              </button>
              {/* Visually hidden but present; the button above is the a11y control. */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,text/plain"
                onChange={handleFile}
                disabled={disabled}
                tabIndex={-1}
                aria-hidden="true"
                className="tv-sr-only"
              />
              <span className="tv-set-cred__spacer" />
              {view.configured && (
                <Button variant="danger-outline" icon="trash" onClick={onRequestDelete}>
                  {t('settings.cred.delete')}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </SettingsSectionCard>
  );
}
