import type { ButtonHTMLAttributes } from 'react';

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'role'> {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export function Switch({
  checked,
  onCheckedChange,
  className = '',
  disabled,
  ...props
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`switch${checked ? ' is-checked' : ''} ${className}`.trim()}
      disabled={disabled}
      onClick={() => {
        onCheckedChange?.(!checked);
      }}
      {...props}
    >
      <span className="switch-thumb" aria-hidden="true" />
    </button>
  );
}
