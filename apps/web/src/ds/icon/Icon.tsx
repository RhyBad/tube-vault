/**
 * Icon — the single wrapper over lucide-react, behind a stable SEMANTIC-name map.
 * The design system flags Lucide as a substitution: routing every glyph through
 * this one map means a house icon set can be swapped in later by editing only
 * this file (readme "Iconography"). Icons are 2px stroke, `currentColor`, so they
 * inherit the surrounding text/intent color and theme automatically.
 *
 * A11y: a `title` makes the icon an accessible image (role=img + name); without
 * one it is decorative (aria-hidden) — because in this system meaning is always
 * ALSO carried by an adjacent text label (the "never color/icon alone" rule).
 */
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpDown,
  ArrowUpToLine,
  Bell,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleDashed,
  CircleHelp,
  Clock,
  Download,
  Ellipsis,
  Eye,
  EyeOff,
  Globe,
  GripVertical,
  HardDrive,
  House,
  Info,
  LayoutGrid,
  Library,
  List,
  ListChecks,
  Loader,
  Lock,
  Minus,
  Moon,
  Pause,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Trash2,
  Users,
  X,
  XOctagon,
  type LucideIcon,
} from 'lucide-react';

/** Semantic name → Lucide glyph. Add here (not at call sites) when a new glyph is needed. */
const ICONS = {
  // navigation (canonical AppShell order)
  home: House,
  queue: ListChecks,
  live: Radio,
  library: Library,
  channels: Users,
  storage: HardDrive,
  server: Server, // 'independent services' cue (S9 settings indep note)
  notifications: Bell,
  settings: Settings,
  more: Ellipsis,
  // shell + actions
  search: Search,
  bell: Bell,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'arrow-right': ArrowRight,
  'arrow-up-to-line': ArrowUpToLine, // reorder: move to top of queue
  'arrow-down-to-line': ArrowDownToLine, // reorder: move to bottom of queue
  grip: GripVertical, // drag handle (queue row reorder)
  x: X,
  minus: Minus,
  plus: Plus,
  download: Download,
  filter: SlidersHorizontal,
  sort: ArrowUpDown,
  retry: RotateCcw,
  play: Play,
  eye: Eye,
  'eye-off': EyeOff,
  'mark-all-read': CheckCheck,
  sun: Sun,
  moon: Moon,
  radio: Radio, // live/broadcast + heartbeat (LiveSessionCard, ChannelCard)
  // state glyphs (StatusBadge / NotificationItem — paired with color + label)
  check: Check,
  'shield-check': ShieldCheck, // the Rescued signature
  loader: Loader,
  clock: Clock,
  pause: Pause,
  alert: AlertTriangle,
  'x-octagon': XOctagon,
  lock: Lock,
  trash: Trash2,
  globe: Globe,
  help: CircleHelp,
  circle: Circle,
  'circle-dashed': CircleDashed,
  info: Info,
  // library view toggle (S4 — grid/list segmented control)
  grid: LayoutGrid,
  list: List,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export interface IconProps {
  name: IconName;
  /** Pixel size for both width and height (14 inline, 16 UI default, 20 nav). */
  size?: number;
  strokeWidth?: number;
  className?: string;
  /** Accessible name. Present → role=img; absent → decorative (aria-hidden). */
  title?: string;
}

export function Icon({
  name,
  size = 16,
  strokeWidth = 2,
  className,
  title,
}: IconProps): React.ReactElement {
  const Glyph = ICONS[name];
  const a11y = title
    ? ({ role: 'img', 'aria-label': title } as const)
    : ({ 'aria-hidden': true } as const);
  return <Glyph size={size} strokeWidth={strokeWidth} className={className} {...a11y} />;
}
