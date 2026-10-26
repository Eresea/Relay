import { Popover } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * A popover anchored to its trigger: menus, pickers, the account card.
 * Radix owns the behaviour (outside click and Escape close it, focus moves in
 * and back, it flips to stay on screen). The content renders in place rather
 * than in a portal, so it stays inside its feature's stylesheet scope;
 * Radix positions it `fixed`, which escapes any clipping container.
 *
 * Pass `open` and `onOpenChange` to close it from code, after a menu item
 * runs, say; leave them out and it manages itself.
 */
export function AppPopover({
  children,
  open,
  onOpenChange,
}: {
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Popover.Root
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      {children}
    </Popover.Root>
  );
}

/** Wraps the one element that opens the popover; it keeps its own markup and styles. */
export function PopoverTrigger(props: ComponentProps<typeof Popover.Trigger>) {
  return <Popover.Trigger asChild {...props} />;
}

export function PopoverContent({
  className,
  role = 'dialog',
  align = 'start',
  sideOffset = 5,
  ...props
}: ComponentProps<typeof Popover.Content> & { role?: 'dialog' | 'menu' }) {
  return (
    <Popover.Content
      role={role}
      align={align}
      sideOffset={sideOffset}
      collisionPadding={8}
      className={cn(
        'z-30 overflow-hidden rounded-(--radius-md) border border-(--border-default) bg-(--bg-overlay) shadow-(--shadow-lg) outline-none',
        className,
      )}
      {...props}
    />
  );
}

/** Closes the enclosing popover when clicked; wrap a menu item that should dismiss it. */
export const PopoverClose = Popover.Close;
