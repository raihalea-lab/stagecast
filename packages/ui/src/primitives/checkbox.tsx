import * as React from "react";
import { cn } from "../lib/cn.js";

export type CheckboxProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">;

/**
 * ネイティブの checkbox に見た目だけ揃えたもの。
 * Radix を足さずに済ませている (a11y はネイティブが一番確実で、フォームの submit にも素直に乗る)。
 */
export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      type="checkbox"
      className={cn(
        "size-4 shrink-0 rounded border-line-2 accent-brand-600 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Checkbox.displayName = "Checkbox";
