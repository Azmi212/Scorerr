import { Eye, EyeOff } from 'lucide-react';
import { type InputHTMLAttributes, useState } from 'react';

import { fieldAria, useFormField } from './FormField';

export function SecretInput({
  className = '',
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [visible, setVisible] = useState(false);
  const field = useFormField();

  return (
    <div className="secret-input-wrap">
      <input
        className={`input secret-input ${className}`.trim()}
        type={visible ? 'text' : 'password'}
        autoComplete="off"
        {...fieldAria(field)}
        {...props}
      />
      <button
        className="secret-toggle"
        type="button"
        aria-label={visible ? 'Masquer la valeur' : 'Afficher la valeur'}
        aria-pressed={visible}
        onClick={() => {
          setVisible((current) => !current);
        }}
      >
        {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
      </button>
    </div>
  );
}
