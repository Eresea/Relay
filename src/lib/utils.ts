import type { CSSProperties } from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Joins class names, letting a later Tailwind utility override an earlier one. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Inline CSS custom properties, typed: `style={vars({ '--entity-hue': tone })}`. */
export function vars(values: Record<`--${string}`, string | number>): CSSProperties {
  return values;
}
