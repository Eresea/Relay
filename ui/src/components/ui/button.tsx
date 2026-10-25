import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * Umbra's button, in shadcn's shape: one component, variant and size props,
 * `asChild` to render as a link. Hover changes fill or adds a halo, never the
 * cursor; disabled dims and is the only state that changes the pointer.
 */
const buttonVariants = cva(
  [
    'relative inline-flex shrink-0 items-center justify-center gap-(--space-3) whitespace-nowrap select-none',
    'h-(--control-h) px-(--space-6) rounded-(--radius-md) border border-transparent',
    '[font:var(--type-ui)] transition-[background-color,border-color,color,box-shadow,opacity] duration-(--dur-fast)',
    'focus-visible:outline-none focus-visible:shadow-(--focus-ring)',
    'active:enabled:translate-y-(--control-press-offset)',
    'disabled:cursor-not-allowed disabled:opacity-45',
    '[&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-(--shadow-xs) hover:enabled:bg-primary-hover hover:enabled:shadow-[var(--shadow-xs),0_0_0_3px_var(--primary-quiet)]',
        secondary:
          'border-line bg-raised text-body shadow-(--shadow-xs) hover:enabled:border-line-strong hover:enabled:bg-hover',
        outline:
          'border-line bg-app text-body hover:enabled:border-line-strong hover:enabled:bg-hover',
        ghost: 'bg-transparent text-body hover:enabled:bg-hover',
        destructive:
          'bg-danger text-(--text-inverted) shadow-(--shadow-xs) hover:enabled:bg-danger-hover hover:enabled:shadow-[var(--shadow-xs),0_0_0_3px_var(--danger-quiet)]',
        link: 'h-auto bg-transparent p-0 text-body underline-offset-(--space-2) hover:enabled:text-(--text-link-hover) hover:enabled:underline',
      },
      size: {
        sm: 'h-(--control-h-sm) px-(--space-5) text-(length:--text-xs)',
        md: '',
        lg: 'h-(--control-h-lg) px-(--space-8) text-(length:--text-base)',
        icon: 'size-(--control-h) p-0',
      },
    },
    compoundVariants: [{ variant: 'link', size: ['sm', 'md', 'lg'], className: 'h-auto px-0' }],
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    /** Render the single child (a link, say) with button styling instead of a <button>. */
    asChild?: boolean;
  };

export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  const Component = asChild ? Slot.Root : 'button';
  return (
    <Component
      data-slot="button"
      // A bare <button> inside a form submits; Relay's buttons only ever act.
      type={asChild ? type : (type ?? 'button')}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { buttonVariants };
