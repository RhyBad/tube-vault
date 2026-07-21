/**
 * TubeVault design system — the public barrel. Screens import DS components from
 * HERE, not from component internals (the adherence rule), so the internal file
 * layout can change without touching call sites. All 30 manifest components +
 * the Icon primitive + the shared state maps.
 */

// Icon
export { Icon, type IconName, type IconProps } from './icon/Icon';

// Status / progress / storage — the instrument dials
export { StatusBadge, type StatusBadgeProps } from './status/StatusBadge';
export {
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
} from './status/state-maps';
export { ProgressBar, type ProgressBarProps } from './progress/ProgressBar';
export { StorageGauge, type StorageGaugeProps } from './storage/StorageGauge';

// Forms
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from './forms/Button';
export { IconButton, type IconButtonProps, type IconButtonVariant } from './forms/IconButton';
export { Checkbox, type CheckboxProps } from './forms/Checkbox';
export { TextField, type TextFieldProps } from './forms/TextField';
export { Select, type SelectProps, type SelectOption } from './forms/Select';
export { NumberStepper, type NumberStepperProps } from './forms/NumberStepper';
export {
  MaskedSecretInput,
  type MaskedSecretInputProps,
  type SecretAction,
  type SecretChange,
} from './forms/MaskedSecretInput';

// Feedback — the "moments"
export { ConfirmDialog, type ConfirmDialogProps } from './feedback/ConfirmDialog';
export { Toast, type ToastProps, type ToastIntent } from './feedback/Toast';
export { EmptyState, type EmptyStateProps, type EmptyVariant } from './feedback/EmptyState';
export { ErrorState, type ErrorStateProps } from './feedback/ErrorState';
export {
  Skeleton,
  SkeletonText,
  type SkeletonProps,
  type SkeletonTextProps,
} from './feedback/Skeleton';
export {
  NotificationItem,
  type NotificationItemProps,
  type Severity,
} from './feedback/NotificationItem';

// Data + navigation
export { DataTable, type DataTableProps, type Column } from './data/DataTable';
export { LoadMoreList, type LoadMoreListProps } from './data/LoadMoreList';
export { Tabs, type TabsProps, type TabItem } from './navigation/Tabs';
export { SortControl, type SortControlProps } from './navigation/SortControl';
export { FilterToolbar, type FilterToolbarProps } from './navigation/FilterToolbar';

// Cards + media
export { VideoCard, type VideoCardProps, type VideoCardVideo } from './cards/VideoCard';
export { ChannelCard, type ChannelCardProps } from './cards/ChannelCard';
export { LiveSessionCard, type LiveSessionCardProps } from './cards/LiveSessionCard';
export { Player, type PlayerProps, type PlayerTrack } from './media/Player';

// Shell
export { AppShell, CANONICAL_NAV, type AppShellProps, type NavItem } from './shell/AppShell';
export { Wordmark, type WordmarkProps } from './shell/Wordmark';
export { SseIndicator, type SseIndicatorProps } from './shell/SseIndicator';
export { BulkActionBar, type BulkActionBarProps, type BulkAction } from './shell/BulkActionBar';
export { SearchOverlay, type SearchOverlayProps } from './shell/SearchOverlay';
export { BellPopup, type BellPopupProps } from './shell/BellPopup';
export { remedyFor, type Remedy, type RemedyKey } from './shell/remedy';
export { SseProvider, useSse, type SseProviderProps } from './shell/SseProvider';
export { useSseStatus, type SseStatus, type SseClientLike } from './shell/useSseStatus';
