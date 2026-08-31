import * as React from 'react';
import { cn } from '@/lib/utils';
import { fieldClassName } from './field';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input ref={ref} type={type} className={cn(fieldClassName, className)} {...props} />
  )
);
Input.displayName = 'Input';
