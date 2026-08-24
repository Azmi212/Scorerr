import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { Spinner } from './Feedback';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'destructive';
  loading?: boolean;
  iconOnly?: boolean;
  children: ReactNode;
}

export function Button({
  variant = 'primary',
  loading = false,
  iconOnly = false,
  className = '',
  disabled,
  children,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`button button-${variant}${iconOnly ? ' button-icon' : ''} ${className}`.trim()}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Spinner size="small" /> : children}
    </button>
  );
}
