import * as React from "react";
import { X } from "lucide-react";
import { cn } from "../lib/cn.js";
import { Button } from "./button.js";

export type AlertVariant = "error" | "warning" | "info";

const variantClass: Record<AlertVariant, string> = {
  error: "border-error/40 bg-error/10 text-error",
  warning: "border-warning/40 bg-warning/10 text-warning",
  info: "border-brand-500/40 bg-brand-tint text-brand-text",
};

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: AlertVariant;
  /** 渡すと右端に「閉じる」ボタンが出る。 */
  onDismiss?: () => void;
}

/**
 * インラインの通知バナー。3 アプリが同じ見た目を 19 箇所で手書きしていたので 1 つにした。
 * 既定で `role="alert"`。中身は自由 (文字列でも、見出し + code のような構造でもよい)。
 */
export function Alert({ variant = "error", onDismiss, className, children, ...props }: AlertProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-3 rounded-md border px-3 py-2 text-sm",
        variantClass[variant],
        className,
      )}
      {...props}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="閉じる"
          onClick={onDismiss}
          className="-my-1 -mr-1 shrink-0"
        >
          <X className="size-4" />
        </Button>
      )}
    </div>
  );
}
