import * as React from 'react';
import { cn } from '@/lib/utils';
import { fieldClassName } from './field';

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(fieldClassName, 'min-h-20 py-2.5', className)} {...props} />
));
Textarea.displayName = 'Textarea';
