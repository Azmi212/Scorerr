import { forwardRef, type SelectHTMLAttributes } from 'react';

import { fieldAria, useFormField } from './FormField';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className = '', children, ...props }, ref) {
    const field = useFormField();
    return (
      <select ref={ref} className={`select ${className}`.trim()} {...fieldAria(field)} {...props}>
        {children}
      </select>
    );
  },
);
