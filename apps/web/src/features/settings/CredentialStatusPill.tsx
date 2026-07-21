/**
 * CredentialStatusPill — a small, token-styled status jewel for the YouTube
 * credential (Verified / Unverified / Expired). The DS StatusBadge models the
 * copy/source/job axes only, not this credential lifecycle, so this is a bespoke
 * feature-local pill (the precedent set by S7's bespoke live cards). State is
 * always colour + icon + label, never colour alone (the a11y rule).
 */
import { Icon, type IconName } from '../../ds';
import type { BadgeIntent } from './settings-presentation';

const INTENT_ICON: Record<BadgeIntent, IconName> = {
  success: 'shield-check',
  progress: 'clock',
  danger: 'alert',
  muted: 'lock',
};

export interface CredentialStatusPillProps {
  intent: BadgeIntent;
  label: string;
}

export function CredentialStatusPill({
  intent,
  label,
}: CredentialStatusPillProps): React.ReactElement {
  return (
    <span className="tv-cred-pill" data-intent={intent}>
      <Icon name={INTENT_ICON[intent]} size={13} className="tv-cred-pill__icon" />
      <span className="tv-cred-pill__label">{label}</span>
    </span>
  );
}
