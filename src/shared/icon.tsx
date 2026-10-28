import {
  Activity,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  Clock,
  Columns2,
  Command,
  Copy,
  Download,
  Ellipsis,
  Eye,
  EyeOff,
  FileText,
  Folder,
  Globe,
  GitBranch,
  GitPullRequest,
  House,
  Inbox,
  Info,
  Library,
  LoaderCircle,
  Lock,
  LockOpen,
  Minus,
  Move,
  Moon,
  PanelLeft,
  PanelRight,
  Pencil,
  Play,
  Plus,
  Search,
  Settings,
  Sparkles,
  Square,
  Star,
  Sun,
  Terminal,
  Trash2,
  TriangleAlert,
  X,
  type LucideIcon,
  Blocks,
  Bot,
  Check,
  Mail,
  Shield,
  User,
} from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Every glyph Relay draws, by Lucide name. Names arrive as strings from the
 * core (a notification's icon) and from stored settings (a project's icon),
 * so the map is explicit: an unknown name draws a circle rather than nothing,
 * and only these glyphs ship in the bundle.
 */
const ICONS = {
  activity: Activity,
  'arrow-left': ArrowLeft,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  circle: Circle,
  'circle-alert': CircleAlert,
  'circle-check': CircleCheck,
  clock: Clock,
  'columns-2': Columns2,
  command: Command,
  copy: Copy,
  download: Download,
  ellipsis: Ellipsis,
  eye: Eye,
  'eye-off': EyeOff,
  'file-text': FileText,
  folder: Folder,
  globe: Globe,
  'git-branch': GitBranch,
  'git-pull-request': GitPullRequest,
  house: House,
  inbox: Inbox,
  info: Info,
  library: Library,
  'loader-circle': LoaderCircle,
  lock: Lock,
  unlock: LockOpen,
  minus: Minus,
  move: Move,
  moon: Moon,
  'panel-left': PanelLeft,
  'panel-right': PanelRight,
  pencil: Pencil,
  play: Play,
  plus: Plus,
  search: Search,
  settings: Settings,
  sparkles: Sparkles,
  square: Square,
  star: Star,
  sun: Sun,
  terminal: Terminal,
  'trash-2': Trash2,
  'triangle-alert': TriangleAlert,
  blocks: Blocks,
  bot: Bot,
  check: Check,
  mail: Mail,
  shield: Shield,
  user: User,
  x: X,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

interface IconProps {
  readonly name: string;
  /** 14 in dense rows, menus and small buttons; 16 default; 20 only inside an empty-state tile. */
  readonly size?: 14 | 16 | 20;
  readonly className?: string;
}

/** The only way a screen draws a glyph. Decorative: hidden from assistive tech. */
export function Icon({ name, size = 16, className }: IconProps) {
  const Glyph = (ICONS as Record<string, LucideIcon>)[name] ?? Circle;
  return (
    <Glyph
      aria-hidden="true"
      width={size}
      height={size}
      strokeWidth={2}
      className={cn('shrink-0', className)}
    />
  );
}
