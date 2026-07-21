/**
 * ConfirmDialog — the destructive-action gate. It names the consequence and, for
 * the irreversible path (purge), requires the operator to TYPE a confirmation
 * phrase before the confirm button enables. Esc cancels; the scrim click cancels.
 * onCancel is held in a ref so the Esc listener never re-binds on parent renders.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../forms/Button';
import { TextField } from '../forms/TextField';
import { Icon } from '../icon/Icon';
import './ConfirmDialog.css';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Style the confirm as destructive. */
  danger?: boolean;
  /** When set, confirm stays disabled until the operator types this exact phrase. */
  requireText?: string;
  className?: string;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  danger = false,
  requireText,
  className,
}: ConfirmDialogProps): React.ReactElement | null {
  const { t } = useTranslation();
  const titleId = useId();
  const [typed, setTyped] = useState('');
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setTyped('');
    // Snapshot the invoking control so focus returns to it on close — else a
    // keyboard/SR user is dumped to <body> and the next Tab restarts from the top
    // (WCAG 2.4.3 Focus Order).
    const invoker = document.activeElement as HTMLElement | null;
    // Move focus into the dialog on open so a keyboard/SR user isn't left on the
    // obscured trigger behind the scrim.
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancelRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      // Restore focus to the invoker if it's still in the document and focusable.
      if (invoker !== null && invoker.isConnected) invoker.focus();
    };
  }, [open]);

  if (!open) return null;

  const gated = requireText !== undefined && requireText !== '';
  const confirmDisabled = gated && typed !== requireText;

  return (
    <div className="tv-modal" role="presentation" onClick={onCancel}>
      <div className="tv-modal__scrim" />
      <div
        ref={panelRef}
        className={`tv-dialog${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tv-dialog__head">
          {danger && <Icon name="alert" size={20} className="tv-dialog__icon" />}
          <h2 id={titleId} className="tv-dialog__title">
            {title}
          </h2>
        </div>
        {description !== undefined && <p className="tv-dialog__body">{description}</p>}
        {gated && (
          <TextField
            label={t('feedback.confirm.typePrompt', { text: requireText })}
            value={typed}
            onChange={setTyped}
            mono
            placeholder={requireText}
          />
        )}
        <div className="tv-dialog__actions">
          <Button variant="secondary" onClick={onCancel}>
            {cancelLabel ?? t('action.cancel')}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            disabled={confirmDisabled}
          >
            {confirmLabel ?? t('action.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
