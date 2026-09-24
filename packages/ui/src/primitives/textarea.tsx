import * as React from "react";
import { cn } from "../lib/cn.js";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "flex w-full rounded-md border border-line-2 bg-surface-1 px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary transition-colors duration-fast disabled:cursor-not-allowed disabled:text-text-disabled",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";
