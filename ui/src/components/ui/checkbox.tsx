import { useId } from 'react';

import { cn } from '@/lib/utils';

import './checkbox.css';

interface CheckboxProps {
  readonly checked: boolean;
  readonly onCheckedChange?: (checked: boolean) => void;
  readonly label?: string;
  readonly disabled?: boolean;
  readonly 'aria-label'?: string;
  readonly className?: string;
}

/** Umbra's checkbox: a native input under a drawn mark. */
export function Checkbox({
  checked,
  onCheckedChange,
  label,
  disabled,
  className,
  'aria-label': ariaLabel,
}: CheckboxProps) {
  const id = useId();
  const mark = (
    <span className="mark">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label ? undefined : ariaLabel}
        onChange={(event) => onCheckedChange?.(event.currentTarget.checked)}
      />
      <span className="indicator" aria-hidden="true">
        {checked && (
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="m2.5 6 2.2 2.2L9.5 3.5" />
          </svg>
        )}
      </span>
    </span>
  );
  return (
    <span className={cn('umbra-checkbox', className)}>
      {label ? (
        <label className="row" htmlFor={id}>
          {mark}
          <span className="label-text">{label}</span>
        </label>
      ) : (
        <span className="row">{mark}</span>
      )}
    </span>
  );
}
