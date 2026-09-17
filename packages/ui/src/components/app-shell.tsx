import * as React from "react";
import { cn } from "../lib/cn.js";

export interface AppShellProps extends React.HTMLAttributes<HTMLDivElement> {
  sidebar: React.ReactNode;
  topBar?: React.ReactNode;
  /** 左 Sidebar の初期幅 (デフォルト 260px)。保存済みの幅があればそちらが優先される。 */
  sidebarWidth?: number;
}

const SIDEBAR_WIDTH_KEY = "stagecast:sidebar-width";
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 520;
/** キーボード操作 1 回あたりの増減幅。 */
const RESIZE_STEP = 16;

const clampWidth = (px: number): number =>
  Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(px)));

/** 保存済みの幅を読む。プライベートウィンドウ等で localStorage が投げても既定値に落とす。 */
function loadWidth(fallback: number): number {
  try {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampWidth(saved) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * admin-web の Linear 風レイアウト。 (Sidebar 可変幅 + 上 TopBar + Main scroll)。
 * 全画面 grid で fixed footer 不要、 ARIA Live Region を 1 個常駐させる。
 *
 * Sidebar は境界をドラッグ (または separator にフォーカスして左右キー) で広げられ、
 * 幅は localStorage に残る。イベント名が長いと 260px では読めないため。
 */
export const AppShell = React.forwardRef<HTMLDivElement, AppShellProps>(
  ({ sidebar, topBar, sidebarWidth = 260, children, className, style, ...props }, ref) => {
    const [width, setWidth] = React.useState(() => loadWidth(sidebarWidth));

    const save = (px: number) => {
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(px));
      } catch {
        // 保存できなくてもリサイズ自体は効かせる。
      }
    };

    // ponytail: AppShell は常に全画面 (h-dvh) 前提なので clientX をそのまま幅にする。
    // 埋め込みレイアウトで使うようになったら shell の左端オフセットを引くこと。
    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
      // preventDefault は互換 mousedown を止めるので、既定のフォーカス付与も消える
      // ブラウザがある。掴んだ直後に矢印キーで微調整できるよう自分でフォーカスする。
      e.preventDefault();
      e.currentTarget.focus();
      e.currentTarget.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      setWidth(clampWidth(e.clientX));
    };
    // pointerup と pointercancel の両方で使う。タッチのキャンセルや OS ジェスチャでは
    // pointerup が来ず、保存されないまま次回リロードで幅が巻き戻るため。
    const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      // state 経由で読むと最後の pointermove が反映される前の値を保存してしまうので、
      // ここでも clientX から計算し直す。
      const next = clampWidth(e.clientX);
      setWidth(next);
      save(next);
    };
    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      const delta = e.key === "ArrowLeft" ? -RESIZE_STEP : e.key === "ArrowRight" ? RESIZE_STEP : 0;
      if (!delta) return;
      e.preventDefault();
      const next = clampWidth(width + delta);
      setWidth(next);
      save(next);
    };

    return (
      <div
        ref={ref}
        className={cn("grid h-dvh overflow-hidden bg-surface-0 text-text-primary", className)}
        style={{
          gridTemplateColumns: `${width}px 1fr`,
          gridTemplateRows: "auto 1fr",
          gridTemplateAreas: `"sidebar topbar" "sidebar main"`,
          ...style,
        }}
        {...props}
      >
        <aside
          style={{ gridArea: "sidebar" }}
          className="relative border-r border-line-1 bg-surface-1"
        >
          {sidebar}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="サイドバーの幅を変更"
            aria-valuenow={width}
            aria-valuemin={MIN_SIDEBAR_WIDTH}
            aria-valuemax={MAX_SIDEBAR_WIDTH}
            tabIndex={0}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onKeyDown}
            onDoubleClick={() => {
              setWidth(sidebarWidth);
              save(sidebarWidth);
            }}
            className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-line-3 focus-visible:bg-info focus-visible:outline-none"
          />
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
    );
  },
);
AppShell.displayName = "AppShell";
