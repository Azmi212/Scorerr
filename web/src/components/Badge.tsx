import type { HTMLAttributes } from 'react';

export function Badge({
  className = '',
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  variant?: 'neutral' | 'info' | 'success' | 'warning' | 'error';
}) {
  const { variant = 'neutral', ...rest } = props;
  return <span className={`badge badge-${variant} ${className}`.trim()} {...rest} />;
}
