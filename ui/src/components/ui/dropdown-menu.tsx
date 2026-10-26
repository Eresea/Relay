import { DropdownMenu as Menu } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';
import { Icon } from '@/shared/icon';

/**
 * A menu of actions: arrow keys move, typing jumps, Escape closes, and
 * submenus open sideways on hover or the right arrow. Radix behaviour,
 * Umbra's menu surface.
 */
export const DropdownMenu = Menu.Root;
export const DropdownMenuSub = Menu.Sub;

export function DropdownMenuTrigger(props: ComponentProps<typeof Menu.Trigger>) {
  return <Menu.Trigger asChild {...props} />;
}

const surface =
  'z-50 min-w-[190px] max-h-[360px] overflow-y-auto rounded-(--radius-md) border border-(--border-default) bg-(--bg-overlay) p-(--space-2) shadow-(--shadow-lg) outline-none';

export function DropdownMenuContent({
  className,
  sideOffset = 5,
  align = 'end',
  ...props
}: ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        className={cn(surface, className)}
        {...props}
      />
    </Menu.Portal>
  );
}

const item =
  'flex w-full items-center gap-(--space-3) whitespace-nowrap rounded-(--radius-sm) px-(--space-3) py-(--space-2) text-start text-body outline-none select-none data-[highlighted]:bg-(--tint-hover) data-[highlighted]:text-strong data-[disabled]:opacity-45';

export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof Menu.Item>) {
  return <Menu.Item className={cn(item, className)} {...props} />;
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof Menu.Label>) {
  return (
    <Menu.Label
      className={cn(
        'm-0 px-(--space-3) py-(--space-2) text-(length:--text-11) font-medium tracking-[0.04em] text-subtle uppercase',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof Menu.Separator>) {
  return (
    <Menu.Separator
      className={cn('-mx-(--space-2) my-(--space-2) h-px bg-(--border-subtle)', className)}
      {...props}
    />
  );
}

export function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof Menu.SubTrigger>) {
  return (
    <Menu.SubTrigger
      className={cn(item, 'data-[state=open]:bg-(--tint-hover)', className)}
      {...props}
    >
      {children}
      <Icon name="chevron-right" size={14} className="ml-auto text-subtle" />
    </Menu.SubTrigger>
  );
}

export function DropdownMenuSubContent({
  className,
  ...props
}: ComponentProps<typeof Menu.SubContent>) {
  return (
    <Menu.Portal>
      <Menu.SubContent
        sideOffset={4}
        collisionPadding={8}
        className={cn(surface, className)}
        {...props}
      />
    </Menu.Portal>
  );
}
