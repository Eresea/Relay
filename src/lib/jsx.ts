import type { ReactNode } from 'react';

/**
 * Renders `then(value)` when `value` is truthy, else `otherwise()`. JSX's
 * stand-in for Angular's `@if (expr; as name)`: the value is read once and
 * named, instead of being read again inside the branch.
 */
export function when<T>(
  value: T,
  then: (value: NonNullable<T>) => ReactNode,
  otherwise?: () => ReactNode,
): ReactNode {
  return value ? then(value) : (otherwise?.() ?? null);
}
