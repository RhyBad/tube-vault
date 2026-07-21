/**
 * ComingSoon — the foundation's screen stub. Every canonical destination routes
 * here until its §B screen PR lands, so the shell + nav are fully wired and
 * navigable now. Built from the DS EmptyState so it already looks considered.
 */
import { useTranslation } from 'react-i18next';

import { EmptyState } from '../ds/feedback/EmptyState';
import type { IconName } from '../ds/icon/Icon';

export interface ComingSoonProps {
  /** The destination's glyph. */
  icon?: IconName;
  /** The destination's (already-localized) name. */
  label?: string;
}

export function ComingSoon({ icon = 'library', label }: ComingSoonProps): React.ReactElement {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon={icon}
      title={label ?? t('common.comingSoon')}
      description={t('common.comingSoonBody')}
    />
  );
}
