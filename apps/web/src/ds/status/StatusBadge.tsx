/**
 * StatusBadge — the 2-axis status signal (CopyState + SourceState) plus the
 * derived Rescued signature. State is ALWAYS color + icon + label, never color
 * alone (the a11y rule). When our copy is HEALTHY but the original is gone, a
 * violet Rescued jewel leads — the emotional peak, reserved for this alone.
 * AWAITING_VERIFY reads with a CALM pulse and its own "Verifying completeness"
 * label, deliberately distinct from the spinning VERIFYING worker.
 *
 * Labels flow through i18n (EN + KO); the badge re-renders on a language switch.
 */
import { useTranslation } from 'react-i18next';

import type { CopyState, JobStatus, SourceState } from '@tubevault/types';

import { Icon, type IconName } from '../icon/Icon';
import {
  COPY_ICON,
  COPY_INTENT,
  JOB_ICON,
  JOB_INTENT,
  SOURCE_ICON,
  SOURCE_INTENT,
  copyAnimation,
  isRescued,
  jobAnimation,
  type Intent,
} from './state-maps';
import './StatusBadge.css';

export interface StatusBadgeProps {
  copyState?: CopyState;
  sourceState?: SourceState;
  /** The DOWNLOAD queue axis (S6 rows) — an independent signal from copy/source. */
  jobStatus?: JobStatus;
  size?: 'sm' | 'md';
  className?: string;
}

interface BadgeProps {
  intent: Intent;
  icon: IconName;
  label: string;
  dataState: string;
  size: 'sm' | 'md';
  animate?: 'spin' | 'pulse';
  eyebrow?: string;
  rescued?: boolean;
}

function Badge({
  intent,
  icon,
  label,
  dataState,
  size,
  animate,
  eyebrow,
  rescued,
}: BadgeProps): React.ReactElement {
  const iconClass = animate ? `tv-badge__icon tv-anim-${animate}` : 'tv-badge__icon';
  return (
    <span
      className={`tv-badge tv-badge--${intent} tv-badge--${size}${rescued ? ' tv-badge--rescued' : ''}`}
      data-state={dataState}
      data-intent={intent}
    >
      {/* Icon is decorative here — the adjacent text label carries the meaning. */}
      <Icon name={icon} size={size === 'sm' ? 12 : 14} className={iconClass} />
      {eyebrow !== undefined && <span className="tv-badge__eyebrow">{eyebrow}</span>}
      <span className="tv-badge__label">{label}</span>
    </span>
  );
}

export function StatusBadge({
  copyState,
  sourceState,
  jobStatus,
  size = 'md',
  className,
}: StatusBadgeProps): React.ReactElement {
  const { t } = useTranslation();
  const rescued = isRescued(copyState, sourceState);

  return (
    <span className={`tv-statusbadge${className ? ` ${className}` : ''}`} role="group">
      {jobStatus !== undefined && (
        <Badge
          intent={JOB_INTENT[jobStatus]}
          icon={JOB_ICON[jobStatus]}
          label={t(`status.job.${jobStatus}`)}
          dataState={`JOB_${jobStatus}`}
          size={size}
          animate={jobAnimation(jobStatus)}
        />
      )}
      {rescued && (
        <Badge
          intent="signature"
          icon="shield-check"
          label={t('status.rescued')}
          dataState="RESCUED"
          size={size}
          rescued
        />
      )}
      {copyState !== undefined && (
        <Badge
          intent={COPY_INTENT[copyState]}
          icon={COPY_ICON[copyState]}
          label={t(`status.copy.${copyState}`)}
          dataState={copyState}
          size={size}
          animate={copyAnimation(copyState)}
        />
      )}
      {sourceState !== undefined && (
        <Badge
          intent={SOURCE_INTENT[sourceState]}
          icon={SOURCE_ICON[sourceState]}
          label={t(`status.source.${sourceState}`)}
          dataState={sourceState}
          size={size}
          eyebrow={t('status.srcEyebrow')}
        />
      )}
    </span>
  );
}
