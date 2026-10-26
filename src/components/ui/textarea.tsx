import { useId, type ComponentProps } from 'react';

import { cn } from '@/lib/utils';

import './textarea.css';

type TextareaProps = Omit<ComponentProps<'textarea'>, 'value' | 'onChange'> & {
  readonly value: string;
  readonly onValueChange?: (value: string) => void;
  readonly label?: string;
  readonly hint?: string;
};

/** Umbra's multi-line field. */
export function Textarea({
  value,
  onValueChange,
  label,
  hint,
  className,
  id,
  rows = 3,
  ...props
}: TextareaProps) {
  const generated = useId();
  const controlId = id ?? generated;
  return (
    <div className={cn('umbra-textarea', className)}>
      <div className="layout">
        {label && (
          <label className="label" htmlFor={controlId}>
            {label}
          </label>
        )}
        <div className="field" data-disabled={props.disabled || undefined}>
          <textarea
            id={controlId}
            rows={rows}
            value={value}
            aria-describedby={hint ? `${controlId}-hint` : undefined}
            onChange={(event) => onValueChange?.(event.currentTarget.value)}
            {...props}
          />
        </div>
        {hint && (
          <small className="description" id={`${controlId}-hint`}>
            {hint}
          </small>
        )}
      </div>
    </div>
  );
}
