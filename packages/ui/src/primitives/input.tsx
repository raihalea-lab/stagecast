import * as React from "react";
import { cn } from "../lib/cn.js";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        ref={ref}
        type={type}
        className={cn(
          "flex h-9 w-full rounded-md border border-line-2 bg-surface-1 px-3 py-1 text-sm text-text-primary placeholder:text-text-tertiary transition-colors duration-fast disabled:cursor-not-allowed disabled:text-text-disabled",
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";
