/**
 * CleanupConfirmDialog — the segmented delete gate for S-ST cleanup. It is
 * feature-local (the DS ConfirmDialog is single-action; this one has two buckets)
 * but reuses the DS modal/dialog chrome + Button/TextField/Icon and the same
 * focus-into-dialog / Esc-cancel / restore-focus discipline.
 *
 * It partitions the selected videos with the shared `partitionForDelete`:
 *  - RECLAIM (non-rescued) — media wiped, row kept re-downloadable (no phrase),
 *  - IRREPLACEABLE / PURGE (rescued = the only surviving copy) — named title-by-
 *    title and gated behind a type-to-confirm phrase before it can be deleted.
 * Confirm reports the two id buckets up; the page fires deleteVideos twice
 * (reclaim + purge) and merges the verdicts into one toast.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Icon, TextField } from '../../ds';
import { formatBytes } from '../../lib/format';
import { partitionForDelete, sumBytes, type CleanupVideo } from './cleanup-eligibility';
import './CleanupConfirmDialog.css';

export interface CleanupConfirmDialogProps {
  open: boolean;
  /** The selected videos (full objects) — partitioned into reclaim/purge here. */
  videos: CleanupVideo[];
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (buckets: { reclaimIds: string[]; purgeIds: string[] }) => void;
}

export function CleanupConfirmDialog({
  open,
  videos,
  busy = false,
  onCancel,
  onConfirm,
}: CleanupConfirmDialogProps): React.ReactElement | null {
  const { t } = useTranslation();
  const titleId = useId();
  const [typed, setTyped] = useState('');
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setTyped('');
    const invoker = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancelRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (invoker !== null && invoker.isConnected) invoker.focus();
    };
  }, [open]);

  if (!open) return null;

  const { reclaim, purge } = partitionForDelete(videos);
  const reclaimBytes = sumBytes(reclaim);
  const purgeBytes = sumBytes(purge);
  const totalCount = reclaim.length + purge.length;
  const typeWord = t('storage.cleanup.confirm.typeWord');
  const needsType = purge.length > 0;
  const confirmDisabled = busy || totalCount === 0 || (needsType && typed.trim() !== typeWord);

  const confirm = (): void => {
    if (confirmDisabled) return;
    onConfirm({ reclaimIds: reclaim.map((v) => v.id), purgeIds: purge.map((v) => v.id) });
  };

  return (
    <div className="tv-modal" role="presentation" onClick={onCancel}>
      <div className="tv-modal__scrim" />
      <div
        ref={panelRef}
        className="tv-dialog tv-cleanupconfirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tv-dialog__head">
          <Icon name="trash" size={20} className="tv-dialog__icon" />
          <div className="tv-cleanupconfirm__heading">
            <h2 id={titleId} className="tv-dialog__title">
              {t('storage.cleanup.confirm.title', { count: totalCount })}
            </h2>
            <p className="tv-cleanupconfirm__subtitle">{t('storage.cleanup.confirm.subtitle')}</p>
          </div>
        </div>

        <div className="tv-cleanupconfirm__segments">
          {reclaim.length > 0 && (
            <section className="tv-cleanupconfirm__seg tv-cleanupconfirm__seg--reclaim">
              <div className="tv-cleanupconfirm__seg-head">
                <span className="tv-cleanupconfirm__seg-icon" aria-hidden="true">
                  <Icon name="retry" size={15} />
                </span>
                <div className="tv-cleanupconfirm__seg-text">
                  <span className="tv-cleanupconfirm__seg-title">
                    {t('storage.cleanup.confirm.reclaimTitle', { count: reclaim.length })}
                  </span>
                  <span className="tv-cleanupconfirm__seg-desc">
                    {t('storage.cleanup.confirm.reclaimDesc')}
                  </span>
                </div>
                <span className="tv-cleanupconfirm__seg-frees tv-numeric">
                  {t('storage.cleanup.confirm.frees', { size: formatBytes(reclaimBytes) })}
                </span>
              </div>
            </section>
          )}

          {purge.length > 0 && (
            <section className="tv-cleanupconfirm__seg tv-cleanupconfirm__seg--purge">
              <div className="tv-cleanupconfirm__seg-head">
                <span className="tv-cleanupconfirm__seg-icon" aria-hidden="true">
                  <Icon name="shield-check" size={15} />
                </span>
                <div className="tv-cleanupconfirm__seg-text">
                  <span className="tv-cleanupconfirm__seg-title">
                    {t('storage.cleanup.confirm.irreplaceableTitle', { count: purge.length })}
                  </span>
                  <span className="tv-cleanupconfirm__seg-desc">
                    {t('storage.cleanup.confirm.irreplaceableDesc')}
                  </span>
                </div>
                <span className="tv-cleanupconfirm__seg-frees tv-numeric">
                  {t('storage.cleanup.confirm.frees', { size: formatBytes(purgeBytes) })}
                </span>
              </div>
              <ul className="tv-cleanupconfirm__titles">
                {purge.map((v) => (
                  <li key={v.id} className="tv-cleanupconfirm__title-row">
                    <span className="tv-cleanupconfirm__title-name">{v.title}</span>
                    <span className="tv-cleanupconfirm__title-size tv-numeric">
                      {formatBytes(v.sizeBytes)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <div className="tv-cleanupconfirm__total">
          <span className="tv-cleanupconfirm__total-label">
            {t('storage.cleanup.confirm.totalFreed')}
          </span>
          <span className="tv-cleanupconfirm__total-val tv-numeric">
            {formatBytes(reclaimBytes + purgeBytes)}
          </span>
        </div>

        {needsType && (
          <div className="tv-cleanupconfirm__type">
            <TextField
              label={
                `${t('storage.cleanup.confirm.typePromptPre')}${typeWord}` +
                t('storage.cleanup.confirm.typePromptPost')
              }
              value={typed}
              onChange={setTyped}
              mono
              placeholder={typeWord}
            />
          </div>
        )}

        <div className="tv-dialog__actions">
          <Button variant="secondary" onClick={onCancel}>
            {t('storage.cleanup.confirm.cancel')}
          </Button>
          <Button variant="danger" onClick={confirm} disabled={confirmDisabled}>
            {t('storage.cleanup.confirm.deleteBtn', { count: totalCount })}
          </Button>
        </div>
      </div>
    </div>
  );
}
