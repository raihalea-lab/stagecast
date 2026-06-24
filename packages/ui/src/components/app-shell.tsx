import * as React from "react";
import { cn } from "../lib/cn.js";

export interface AppShellProps extends React.HTMLAttributes<HTMLDivElement> {
  sidebar: React.ReactNode;
  topBar?: React.ReactNode;
  /** 左 Sidebar の幅 (デフォルト 260px)。 */
  sidebarWidth?: number;
}

/**
 * admin-web の Linear 風レイアウト。 (Sidebar 固定幅 + 上 TopBar + Main scroll)。
 * 全画面 grid で fixed footer 不要、 ARIA Live Region を 1 個常駐させる。
 */
export const AppShell = React.forwardRef<HTMLDivElement, AppShellProps>(
  ({ sidebar, topBar, sidebarWidth = 260, children, className, style, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("grid min-h-dvh bg-surface-0 text-text-primary", className)}
      style={{
        gridTemplateColumns: `${sidebarWidth}px 1fr`,
        gridTemplateRows: "auto 1fr",
        gridTemplateAreas: `"sidebar topbar" "sidebar main"`,
        ...style,
      }}
      {...props}
    >
      <aside style={{ gridArea: "sidebar" }} className="border-r border-line-1 bg-surface-1">
        {sidebar}
      </aside>
      <header
        style={{ gridArea: "topbar" }}
        className="border-b border-line-1 bg-surface-0/80 backdrop-blur"
      >
        {topBar}
      </header>
      <main
        style={{ gridArea: "main" }}
        className="overflow-auto"
        aria-live="polite"
        aria-atomic="false"
      >
        {children}
      </main>
    </div>
  ),
);
AppShell.displayName = "AppShell";
