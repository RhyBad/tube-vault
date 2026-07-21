/**
 * SettingsSectionCard — the shared shell every S9 section renders inside: the
 * eyebrow/title/description header, the "NN / 03" index, the EP-code chip, and
 * the three independent load states (skeleton / retryable error / ready). Each
 * section is decoupled (spec §6) — its own error shell never blocks the others.
 */
import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorState, SkeletonText } from '../../ds';
import type { SectionPhase } from './settings-presentation';
import './SettingsPage.css';

export interface SettingsSectionCardProps {
  /** 1-based position, rendered as "01 / 03". */
  index: number;
  eyebrow: string;
  title: string;
  description: string;
  /** The GET/PATCH… code chip (e.g. "GET · PATCH /api/settings"). */
  epLabel: string;
  phase: SectionPhase;
  onRetry: () => void;
  children: ReactNode;
}

const TOTAL = 3;

export function SettingsSectionCard({
  index,
  eyebrow,
  title,
  description,
  epLabel,
  phase,
  onRetry,
  children,
}: SettingsSectionCardProps): React.ReactElement {
  const { t } = useTranslation();
  const titleId = useId();

  return (
    <section className="tv-set__section" aria-labelledby={titleId}>
      <header className="tv-set__head">
        <div className="tv-set__head-main">
          <span className="tv-set__eyebrow">{eyebrow}</span>
          <h2 id={titleId} className="tv-set__title">
            {title}
          </h2>
          <p className="tv-set__desc">{description}</p>
        </div>
        <div className="tv-set__head-meta">
          <span className="tv-set__index tv-numeric">
            {String(index).padStart(2, '0')} / {String(TOTAL).padStart(2, '0')}
          </span>
          <code className="tv-set__ep">{epLabel}</code>
        </div>
      </header>

      {phase === 'loading' && <SkeletonText lines={3} height={16} gap={12} />}
      {phase === 'error' && (
        <ErrorState
          title={t('settings.common.secErrTitle')}
          description={t('settings.common.secErrDesc')}
          onRetry={onRetry}
        />
      )}
      {phase === 'ready' && children}
    </section>
  );
}
