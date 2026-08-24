import { AlertCircle, CheckCircle2, Info, TriangleAlert } from 'lucide-react';
import type { HTMLAttributes } from 'react';

export function Spinner({
  size = 'medium',
  label = 'Chargement',
}: {
  size?: 'small' | 'medium';
  label?: string;
}) {
  return (
    <span className={`spinner spinner-${size}`} role="status">
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function Skeleton({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`skeleton ${className}`.trim()} aria-hidden="true" {...props} />;
}

const alertIcons = {
  info: Info,
  success: CheckCircle2,
  warning: TriangleAlert,
  error: AlertCircle,
};

export function Alert({
  variant = 'info',
  title,
  children,
}: {
  variant?: keyof typeof alertIcons;
  title: string;
  children?: React.ReactNode;
}) {
  const Icon = alertIcons[variant];
  return (
    <div className={`alert alert-${variant}`} role={variant === 'error' ? 'alert' : 'status'}>
      <Icon aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        {children ? <div>{children}</div> : null}
      </div>
    </div>
  );
}
