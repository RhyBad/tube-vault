/**
 * QueueRow — one DOWNLOAD job, presentational. It derives which controls to show
 * from (status × tab) per the §3 state machine and calls the page-supplied
 * handlers; it owns no data or network. RUNNING can't be reordered (a disabled
 * grip explains why, §10.4); the progress bar shows only when the DTO carries
 * progress (RUNNING/PAUSED/COMPLETED); an optimistic `pending` label replaces the
 * buttons between the click and the confirming job.changed.
 *
 * Responsive (§S6): at DESKTOP the row is a dense grid TABLE row aligned to the
 * page header (checkbox · grip · video · status · progress · order · try ·
 * actions). Below --tv-bp-md it folds to a stacked CARD where progress · status ·
 * Cancel/Pause/Resume stay inline and reorder + bulk-select + the event-log entry
 * move into a per-card overflow sheet (§S6-R1). Drag props (HTML5 DnD) apply on
 * the desktop table only.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import type { QueueItemDto } from '@tubevault/types';

import { Button, Checkbox, Icon, IconButton, ProgressBar, StatusBadge } from '../../ds';
import { formatBytes, formatDuration, formatSpeed } from '../../lib/format';
import { formatRelativeTime } from '../../i18n/format';
import { tabAllowsRequeue, type QueueTab } from './tabs';
import { useIsDesktop } from './useIsDesktop';
import type { RowPending } from './useQueue';
import './QueueRow.css';

/** HTML5 drag-and-drop wiring supplied by the page's reorder controller. */
export interface RowDragProps {
  draggable: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnter: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
}

export interface QueueRowProps {
  item: QueueItemDto;
  tab: QueueTab;
  pending?: RowPending;
  /**
   * §S6-1: the friendly sequential position among the non-RUNNING active band
   * (#1, #2, …), computed by the page. Undefined for RUNNING rows and every
   * history tab; the raw gap priority stays in the cell tooltip.
   */
  orderPosition?: number;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (checked: boolean) => void;
  /** §S6-R1: the mobile sheet's "Select for bulk" enters selection mode first. */
  onEnterSelect?: () => void;
  onCancel?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  onMoveTop?: () => void;
  onMoveBottom?: () => void;
  onRequeue?: () => void;
  /** Drill-down (EP-26) toggle + the log panel to render when open. */
  expanded?: boolean;
  onToggleLog?: () => void;
  logSlot?: React.ReactNode;
  /** Reorder DnD (active tab, QUEUED/PAUSED only) — desktop table only. */
  dragProps?: RowDragProps;
  isDragging?: boolean;
  isDropTarget?: boolean;
}

export function QueueRow({
  item,
  tab,
  pending,
  orderPosition,
  selectable = false,
  selected = false,
  onToggleSelect,
  onEnterSelect,
  onCancel,
  onPause,
  onResume,
  onMoveTop,
  onMoveBottom,
  onRequeue,
  expanded = false,
  onToggleLog,
  logSlot,
  dragProps,
  isDragging = false,
  isDropTarget = false,
}: QueueRowProps): React.ReactElement {
  const { t, i18n } = useTranslation();
  const isDesktop = useIsDesktop();
  const [sheetOpen, setSheetOpen] = useState(false);
  const { status, progress } = item;
  const isActive = tab === 'active';

  const showCancel =
    isActive && (status === 'QUEUED' || status === 'RUNNING' || status === 'PAUSED');
  const showPause = isActive && (status === 'QUEUED' || status === 'RUNNING');
  const showResume = isActive && status === 'PAUSED';
  const canReorder = isActive && (status === 'QUEUED' || status === 'PAUSED');
  const runningActive = isActive && status === 'RUNNING';
  const showRequeue = tabAllowsRequeue(tab);
  const logId = `joblog-${item.jobId}`;
  const hasError = item.error !== null && item.error !== '';
  // §S6-3: active-tab errors are retry-pending (amber); a terminal history-tab
  // error is a real failure (red).
  const errorTone: 'warning' | 'danger' = isActive ? 'warning' : 'danger';

  // §8: an unknown total (size not yet known) must read as such, not silently omit
  // the total. Override the bar's readout with an explicit "unknown size" marker.
  const unknownSizeLabel =
    progress !== null && progress.totalBytes === null
      ? [
          formatBytes(progress.downloadedBytes),
          t('queue.row.unknownTotal'),
          progress.speedBps !== null ? formatSpeed(progress.speedBps) : null,
          progress.etaSeconds !== null
            ? t('progress.etaLeft', { time: formatDuration(progress.etaSeconds) })
            : null,
        ]
          .filter((p): p is string => p !== null)
          .join(' · ')
      : undefined;

  // §S6-1: Order cell — ▶ for the running download, #N among the waiting band,
  // else a dash; the raw gap priority moves into the tooltip.
  let orderText = '—';
  let orderTitle: string | undefined;
  if (runningActive) {
    orderText = '▶';
    orderTitle = t('queue.row.orderRunning');
  } else if (isActive && orderPosition != null) {
    orderText = t('queue.row.position', { position: orderPosition });
    orderTitle =
      item.priority !== null
        ? t('queue.row.orderTip', { priority: item.priority })
        : t('queue.row.orderTipUnknown');
  }
  const tryText = item.attempt > 1 ? `×${item.attempt}` : String(item.attempt);
  const tryTitle = t('queue.row.attempt', { count: item.attempt });

  // ── shared fragments ───────────────────────────────────────────────────────
  const titleLink = (
    <Link to={`/videos/${item.videoId}`} className="tv-qrow__title">
      {item.title}
    </Link>
  );
  const channelLink = (
    <Link to={`/channels/${item.channelId}`} className="tv-qrow__channel">
      {item.channelTitle}
    </Link>
  );
  const statusBadge = <StatusBadge jobStatus={status} size="sm" />;
  const pendingLabel = (
    <span className="tv-qrow__pending" role="status">
      <Icon name="loader" size={14} className="tv-anim-spin" />
      {pending !== undefined ? t(`queue.pending.${pending}`) : null}
    </span>
  );
  const progressBar =
    progress !== null ? (
      <ProgressBar
        className="tv-qrow__progress"
        size="sm"
        // §S6-2: a paused bar reads amber, a completed bar green — the semantic
        // color the adjacent StatusBadge alone used to carry.
        intent={status === 'PAUSED' ? 'warning' : status === 'COMPLETED' ? 'success' : 'progress'}
        pct={progress.pct}
        downloadedBytes={progress.downloadedBytes}
        totalBytes={progress.totalBytes}
        speedBps={progress.speedBps}
        etaSeconds={progress.etaSeconds}
        label={unknownSizeLabel}
      />
    ) : null;
  // §S6-6: a QUEUED active row has no progress bar — fill the slot with why it waits.
  const waitingHint =
    isActive && status === 'QUEUED' ? (
      <p className="tv-qrow__waiting">
        {item.errorKind === 'RATE_LIMITED'
          ? t('queue.row.waitingRetry')
          : t('queue.row.waitingSlot')}
      </p>
    ) : null;
  // §S6-Queue-M1: the status-relevant timestamp as a relative-time meta dot.
  const timeMeta = ((): React.ReactNode => {
    let iso: string | null = null;
    let key: 'timeStarted' | 'timePaused' | 'timeQueued' | 'timeFinished' | null = null;
    if (status === 'RUNNING' && item.startedAt !== null) {
      iso = item.startedAt;
      key = 'timeStarted';
    } else if (status === 'PAUSED' && item.pausedAt !== null) {
      iso = item.pausedAt;
      key = 'timePaused';
    } else if (isActive && status === 'QUEUED') {
      iso = item.enqueuedAt;
      key = 'timeQueued';
    } else if (!isActive && item.finishedAt !== null) {
      iso = item.finishedAt;
      key = 'timeFinished';
    }
    if (iso === null || key === null) return null;
    return (
      <time className="tv-qrow__dot" dateTime={iso}>
        {t(`queue.row.${key}`, { time: formatRelativeTime(iso, i18n.language) })}
      </time>
    );
  })();
  const errorStrip = hasError ? (
    <p className={`tv-qrow__error tv-qrow__error--${errorTone}`} data-tone={errorTone}>
      <Icon name="alert" size={14} />
      <span>{item.error}</span>
    </p>
  ) : null;
  const logToggle = (
    <IconButton
      size="sm"
      variant="ghost"
      label={expanded ? t('queue.row.hideLog') : t('queue.row.openLog')}
      aria-expanded={expanded}
      aria-controls={logId}
      onClick={onToggleLog}
    >
      <Icon
        name="chevron-down"
        size={15}
        className={expanded ? 'tv-qrow__chev--open' : undefined}
      />
    </IconButton>
  );
  const logPanel =
    expanded && logSlot !== undefined && logSlot !== null ? (
      <div className="tv-qrow__log tv-qrow__span" id={logId}>
        {logSlot}
      </div>
    ) : null;
  const orderCell = (
    <span
      className="tv-qrow__order"
      data-running={runningActive ? '' : undefined}
      title={orderTitle}
    >
      {orderText}
    </span>
  );

  // Primary per-status actions (shared) — cancel/pause/resume/requeue.
  const primaryActions = (full: boolean): React.ReactNode => {
    const variant = full ? { size: 'md' as const, fullWidth: true } : { size: 'sm' as const };
    return (
      <>
        {showResume && (
          <Button {...variant} variant="secondary" icon="play" onClick={onResume}>
            {t('queue.actions.resume')}
          </Button>
        )}
        {showPause && (
          <Button {...variant} variant="ghost" icon="pause" onClick={onPause}>
            {t('queue.actions.pause')}
          </Button>
        )}
        {showRequeue && (
          <Button {...variant} variant="secondary" icon="retry" onClick={onRequeue}>
            {t('queue.actions.requeue')}
          </Button>
        )}
        {showCancel && (
          <Button {...variant} variant="danger-outline" icon="x" onClick={onCancel}>
            {t('queue.actions.cancel')}
          </Button>
        )}
      </>
    );
  };

  // ── MOBILE: stacked card + overflow sheet (§S6-R1) ─────────────────────────
  if (!isDesktop) {
    const hasPrimary = showResume || showPause || showRequeue || showCancel;
    const sheetItems: {
      key: string;
      icon: React.ComponentProps<typeof Icon>['name'];
      label: string;
      run?: () => void;
    }[] = [];
    if (isActive && !selectable) {
      sheetItems.push({
        key: 'select',
        icon: 'check',
        label: t('queue.sheet.selectForBulk'),
        run: () => {
          onEnterSelect?.();
          onToggleSelect?.(true);
        },
      });
    }
    if (canReorder) {
      sheetItems.push({
        key: 'top',
        icon: 'arrow-up-to-line',
        label: t('queue.actions.moveTop'),
        run: onMoveTop,
      });
      sheetItems.push({
        key: 'bottom',
        icon: 'arrow-down-to-line',
        label: t('queue.actions.moveBottom'),
        run: onMoveBottom,
      });
    }
    sheetItems.push({ key: 'log', icon: 'list', label: t('queue.row.openLog'), run: onToggleLog });

    return (
      <article className="tv-qrow tv-qrow--card" data-status={status}>
        <div className="tv-qrow__cardtop">
          {selectable && (
            <Checkbox
              checked={selected}
              hideLabel
              label={item.title}
              onChange={(c) => onToggleSelect?.(c)}
            />
          )}
          <div className="tv-qrow__cardtitle">
            {titleLink}
            <div className="tv-qrow__meta tv-numeric">
              {channelLink}
              {item.attempt > 1 && (
                <span className="tv-qrow__dot">
                  {t('queue.row.attempt', { count: item.attempt })}
                </span>
              )}
              {timeMeta}
            </div>
          </div>
          <IconButton
            size="sm"
            variant="ghost"
            label={t('queue.row.more')}
            onClick={() => setSheetOpen(true)}
          >
            <Icon name="more" size={18} />
          </IconButton>
        </div>

        <div className="tv-qrow__cardstatus">
          {pending !== undefined ? pendingLabel : statusBadge}
          {isActive && orderText !== '—' && orderCell}
        </div>

        {progressBar ?? waitingHint}
        {errorStrip}

        {pending === undefined && hasPrimary && (
          <div className="tv-qrow__cardactions">{primaryActions(true)}</div>
        )}

        {logPanel}

        {sheetOpen && (
          <div className="tv-qrow__sheet-scrim" onClick={() => setSheetOpen(false)}>
            <div
              className="tv-qrow__sheet"
              role="dialog"
              aria-modal="true"
              aria-label={t('queue.sheet.label', { title: item.title })}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="tv-qrow__sheet-grip" aria-hidden="true" />
              <p className="tv-qrow__sheet-title">{item.title}</p>
              {sheetItems.map((mi) => (
                <button
                  key={mi.key}
                  type="button"
                  className="tv-qrow__sheet-item"
                  onClick={() => {
                    setSheetOpen(false);
                    mi.run?.();
                  }}
                >
                  <Icon name={mi.icon} size={18} />
                  <span>{mi.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </article>
    );
  }

  // ── DESKTOP: dense grid table row (§S6-L1) ─────────────────────────────────
  return (
    <article
      className="tv-qrow tv-qrow--table"
      data-status={status}
      data-dragging={isDragging ? '' : undefined}
      data-droptarget={isDropTarget ? '' : undefined}
      draggable={dragProps?.draggable}
      onDragStart={dragProps?.onDragStart}
      onDragEnter={dragProps?.onDragEnter}
      onDragOver={dragProps?.onDragOver}
      onDragLeave={dragProps?.onDragLeave}
      onDrop={dragProps?.onDrop}
      onDragEnd={dragProps?.onDragEnd}
    >
      <div className="tv-qrow__c tv-qrow__c--select">
        {selectable && (
          <Checkbox
            checked={selected}
            hideLabel
            label={item.title}
            onChange={(c) => onToggleSelect?.(c)}
          />
        )}
      </div>

      <div className="tv-qrow__c tv-qrow__c--grip">
        {canReorder ? (
          <span className="tv-qrow__grip" aria-hidden="true" title={t('queue.row.dragHandle')}>
            <Icon name="grip" size={16} />
          </span>
        ) : runningActive ? (
          <span
            className="tv-qrow__grip tv-qrow__grip--locked"
            role="img"
            aria-label={t('queue.reorder.runningLocked')}
            title={t('queue.reorder.runningLocked')}
          >
            <Icon name="grip" size={16} />
          </span>
        ) : null}
      </div>

      <div className="tv-qrow__c tv-qrow__c--video">
        <div className="tv-qrow__head">{titleLink}</div>
        <div className="tv-qrow__meta tv-numeric">
          {channelLink}
          {timeMeta}
        </div>
      </div>

      <div className="tv-qrow__c tv-qrow__c--status">{statusBadge}</div>

      <div className="tv-qrow__c tv-qrow__c--progress">{progressBar ?? waitingHint}</div>

      <div className="tv-qrow__c tv-qrow__c--order">{orderCell}</div>

      <div className="tv-qrow__c tv-qrow__c--try">
        <span
          className="tv-qrow__try"
          data-multi={item.attempt > 1 ? '' : undefined}
          title={tryTitle}
        >
          {tryText}
        </span>
      </div>

      <div className="tv-qrow__c tv-qrow__c--actions">
        <div className="tv-qrow__actions">
          {pending !== undefined ? (
            pendingLabel
          ) : (
            <>
              {primaryActions(false)}
              {canReorder && (
                <span className="tv-qrow__reorder">
                  <IconButton
                    size="sm"
                    variant="ghost"
                    label={t('queue.actions.moveTop')}
                    onClick={onMoveTop}
                  >
                    <Icon name="arrow-up-to-line" size={15} />
                  </IconButton>
                  <IconButton
                    size="sm"
                    variant="ghost"
                    label={t('queue.actions.moveBottom')}
                    onClick={onMoveBottom}
                  >
                    <Icon name="arrow-down-to-line" size={15} />
                  </IconButton>
                </span>
              )}
            </>
          )}
          {logToggle}
        </div>
      </div>

      {errorStrip && <div className="tv-qrow__span tv-qrow__errorrow">{errorStrip}</div>}
      {logPanel}
    </article>
  );
}
