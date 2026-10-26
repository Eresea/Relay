import { useId, useState, type ComponentProps } from 'react';

import { cn } from '@/lib/utils';

import './input.css';

type InputProps = Omit<ComponentProps<'input'>, 'value' | 'onChange'> & {
  readonly value: string;
  readonly onValueChange?: (value: string) => void;
  readonly label?: string;
  readonly hint?: string;
  readonly error?: string;
  readonly invalid?: boolean;
};

/**
 * Umbra's text field: a label, the field, and one line of help or error.
 * The field owns its whole focus indicator; a password field carries its own
 * show/hide toggle.
 */
export function Input({
  value,
  onValueChange,
  label,
  hint,
  error,
  invalid = false,
  type = 'text',
  className,
  disabled,
  id,
  ...props
}: InputProps) {
  const generated = useId();
  const controlId = id ?? generated;
  const [passwordVisible, setPasswordVisible] = useState(false);
  const hasError = invalid || !!error;
  const describedBy = error ? `${controlId}-error` : hint ? `${controlId}-hint` : undefined;

  return (
    <div className={cn('umbra-input', className)} data-type={type}>
      <div className="layout">
        {label && (
          <label className="label" htmlFor={controlId}>
            {label}
            {props.required && (
              <span className="required" aria-hidden="true">
                *
              </span>
            )}
          </label>
        )}
        <div
          className="field"
          data-invalid={hasError || undefined}
          data-disabled={disabled || undefined}
        >
          <input
            id={controlId}
            type={type === 'password' && passwordVisible ? 'text' : type}
            value={value}
            disabled={disabled}
            aria-invalid={hasError || undefined}
            aria-describedby={describedBy}
            onChange={(event) => onValueChange?.(event.currentTarget.value)}
            {...props}
          />
          {type === 'password' && !disabled && (
            <button
              type="button"
              className="action"
              aria-pressed={passwordVisible}
              onClick={() => setPasswordVisible((visible) => !visible)}
            >
              {passwordVisible ? 'Hide password' : 'Show password'}
            </button>
          )}
        </div>
        {error ? (
          <small className="description error" id={`${controlId}-error`}>
            {error}
          </small>
        ) : (
          hint && (
            <small className="description" id={`${controlId}-hint`}>
              {hint}
            </small>
          )
        )}
      </div>
    </div>
  );
}
