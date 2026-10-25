import { cn } from '@/lib/utils';

/**
 * Keycaps. The only non-Lucide glyphs in the system are the platform keyboard
 * symbols, set in mono here.
 */
export function Kbd({ keys, className }: { keys: readonly string[]; className?: string }) {
  return (
    <span data-slot="kbd" className={cn('inline-flex items-center gap-(--space-2)', className)}>
      {keys.map((key) => (
        <kbd
          key={key}
          className="grid h-[18px] min-w-[18px] place-items-center rounded-(--radius-xs) border border-(--border-subtle) bg-(--bg-raised) px-(--space-3) font-mono text-(length:--text-11) leading-none text-subtle shadow-(--keycap-hairline)"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}
