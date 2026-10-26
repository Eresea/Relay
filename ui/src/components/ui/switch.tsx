import { useId } from 'react';

import { cn } from '@/lib/utils';

import './switch.css';

interface SwitchProps {
  readonly checked: boolean;
  readonly onCheckedChange?: (checked: boolean) => void;
  readonly label?: string;
  readonly disabled?: boolean;
  readonly 'aria-label'?: string;
  readonly className?: string;
}

/** Umbra's on/off switch: a native checkbox with role="switch", so keyboard and forms work. */
export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled,
  className,
  'aria-label': ariaLabel,
}: SwitchProps) {
  const id = useId();
  const control = (
    <span className="control">
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-label={label ? undefined : ariaLabel}
        onChange={(event) => onCheckedChange?.(event.currentTarget.checked)}
      />
      <span className="track" aria-hidden="true" />
      <span className="thumb" aria-hidden="true" />
    </span>
  );
  return (
    <span className={cn('umbra-switch', className)}>
      {label ? (
        <label className="row" htmlFor={id}>
          {control}
          <span className="label-text">{label}</span>
        </label>
      ) : (
        <span className="row">{control}</span>
      )}
    </span>
  );
}
