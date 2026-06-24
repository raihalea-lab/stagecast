import * as React from "react";
import { cn } from "../lib/cn.js";

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}

/**
 * 空状態の統一表示。 icon は使わない場合多いが、 渡せば mute トーンで描画する。
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line-1 bg-surface-1 px-6 py-10 text-center",
        className,
      )}
      {...props}
    >
      {icon && <div className="text-text-tertiary [&_svg]:size-6">{icon}</div>}
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-text-primary">{title}</p>
        {description && <p className="text-xs text-text-secondary">{description}</p>}
      </div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
