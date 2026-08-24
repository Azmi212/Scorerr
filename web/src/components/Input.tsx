import { forwardRef, type InputHTMLAttributes } from 'react';

import { fieldAria, useFormField } from './FormField';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = '', ...props }, ref) {
    const field = useFormField();
    return (
      <input ref={ref} className={`input ${className}`.trim()} {...fieldAria(field)} {...props} />
    );
  },
);
