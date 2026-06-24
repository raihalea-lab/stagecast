import * as React from "react";
import { cn } from "../lib/cn.js";
import { LiveTensionBar, type TensionState } from "./live-tension-bar.js";

export interface StageShellProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 最上部 LiveTensionBar の状態。 */
  tension: TensionState;
  header?: React.ReactNode;
  controlBar?: React.ReactNode;
}

/**
 * stage-web 用シェル: 最上部 LiveTensionBar (2px) → header → main → sticky controlBar。
 * dark 固定 (登壇者ブースは暗い方が配信中まぶしくない)。
 */
export const StageShell = React.forwardRef<HTMLDivElement, StageShellProps>(
  ({ tension, header, controlBar, children, className, ...props }, ref) => (
    <div
      ref={ref}
      data-theme="dark"
      className={cn("flex min-h-dvh flex-col bg-surface-0 text-text-primary", className)}
      {...props}
    >
      <LiveTensionBar state={tension} />
      {header && (
        <header className="border-b border-line-1 bg-surface-1 px-4 h-12 flex items-center">
          {header}
        </header>
      )}
      <main className="flex-1 overflow-auto px-4 py-4" aria-live="polite" aria-atomic="false">
        {children}
      </main>
      {controlBar}
    </div>
  ),
);
StageShell.displayName = "StageShell";
