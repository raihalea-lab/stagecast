import * as React from "react";
import { cn } from "../lib/cn.js";
import { Label } from "../primitives/label.js";

export interface FormFieldProps {
  /** 入力要素の id。Label の htmlFor と error の aria-describedby に使う。 */
  id: string;
  label: React.ReactNode;
  /** 入力の下に出す補足。error があるときは error に置き換わる。 */
  hint?: React.ReactNode;
  error?: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}

/**
 * Label + 入力 + 補足 / エラーの 1 組。7 ファイル 28 組が `grid gap-2` + Label を手書きしていた。
 * error を渡すと、直下の入力要素に aria-invalid と aria-describedby を付けて読み上げに乗せる。
 */
export function FormField({
  id,
  label,
  hint,
  error,
  required,
  className,
  children,
}: FormFieldProps) {
  const errorId = `${id}-error`;
  const content = error
    ? React.Children.map(children, (child) =>
        React.isValidElement<Record<string, unknown>>(child) && child.props.id === id
          ? React.cloneElement(child, { "aria-invalid": true, "aria-describedby": errorId })
          : child,
      )
    : children;
  return (
    <div className={cn("grid gap-2", className)}>
      <Label htmlFor={id} className="flex items-center gap-2">
        {label}
        {required && (
          <span aria-hidden className="text-error">
            *
          </span>
        )}
      </Label>
      {content}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-error">
          {error}
        </p>
      ) : (
        hint && <p className="text-xs text-text-tertiary">{hint}</p>
      )}
    </div>
  );
}
