/**
 * NotificationRow — adapts one NotificationDto onto the DS NotificationItem.
 * Severity comes STRICTLY from the DTO (never re-picked per surface); the violet
 * rescue tone is applied ONLY to video.rescued; the remedy link + routing come
 * from the shared ds/shell/remedy map (remedyFor). Unread = dismissedAt === null.
 * All orchestration (dismiss timers, routing) is the page's — this is presentation.
 */
import { useTranslation } from 'react-i18next';

import type { NotificationDto } from '@tubevault/types';

import { NotificationItem } from '../../ds/feedback/NotificationItem';
import { remedyFor } from '../../ds/shell/remedy';

export interface NotificationRowProps {
  notification: NotificationDto;
  /** Deferred-commit dismiss (page holds the POST for the undo window). */
  onDismiss: (id: string) => void;
  /** Navigate to the remedy target (page owns the router). */
  onRemedy: (target: string) => void;
}

export function NotificationRow({
  notification: n,
  onDismiss,
  onRemedy,
}: NotificationRowProps): React.ReactElement {
  const { t } = useTranslation();
  const remedy = remedyFor(n);

  return (
    <NotificationItem
      severity={n.severity}
      tone={n.type === 'video.rescued' ? 'rescue' : 'severity'}
      title={n.title}
      body={n.body !== '' ? n.body : undefined}
      timestamp={n.createdAt}
      unread={n.dismissedAt === null}
      targetLabel={remedy !== null ? t(remedy.labelKey) : undefined}
      onTargetClick={remedy !== null ? () => onRemedy(remedy.target) : undefined}
      onDismiss={n.dismissedAt === null ? () => onDismiss(n.id) : undefined}
    />
  );
}
