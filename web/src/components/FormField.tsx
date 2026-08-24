import { createContext, type ReactNode, useContext, useId } from 'react';

interface FieldContextValue {
  controlId: string;
  descriptionId?: string;
  errorId?: string;
  invalid: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

export interface FormFieldProps {
  children: ReactNode;
  error?: string;
  helperText?: string;
  className?: string;
}

export function FormField({ children, error, helperText, className = '' }: FormFieldProps) {
  const id = useId();
  const value: FieldContextValue = {
    controlId: `field-${id}`,
    invalid: Boolean(error),
    ...(helperText ? { descriptionId: `field-${id}-helper` } : {}),
    ...(error ? { errorId: `field-${id}-error` } : {}),
  };

  return (
    <FieldContext.Provider value={value}>
      <div className={`form-field ${className}`.trim()}>
        {children}
        {helperText ? (
          <p id={value.descriptionId} className="field-helper">
            {helperText}
          </p>
        ) : null}
        {error ? (
          <p id={value.errorId} className="field-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}

export function useFormField() {
  return useContext(FieldContext);
}

export function FieldLabel({ children }: { children: ReactNode }) {
  const field = useFormField();
  return (
    <label className="field-label" htmlFor={field?.controlId}>
      {children}
    </label>
  );
}

export function fieldAria(field: FieldContextValue | null) {
  if (!field) return {};
  const describedBy = [field.descriptionId, field.errorId].filter(Boolean).join(' ') || undefined;
  return {
    id: field.controlId,
    'aria-invalid': field.invalid || undefined,
    'aria-describedby': describedBy,
  };
}
