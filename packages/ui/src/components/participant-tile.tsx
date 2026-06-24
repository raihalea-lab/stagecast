import * as React from "react";
import { cn } from "../lib/cn.js";
import { TallyIndicator } from "./tally-indicator.js";

/**
 * composer-template (Egress Chrome) で使う video tile の presentation 層。
 * 映像 track の attach は composer-template 側の useEffect で行い、 ここは
 * その video 要素のラッパとして lower third / Tally / screen_share 枠を提供する。
 *
 * D2 では骨格のみ。 D11 で composer-template に組み込んで track attach の責務を完成させる。
 */
export interface ParticipantTileProps extends React.HTMLAttributes<HTMLDivElement> {
  identity: string;
  name?: string;
  role?: string;
  isTalking: boolean;
  isScreenShare: boolean;
  /** TallyIndicator の表示有無 (将来、 配信中のみ true にする用)。 */
  showTally?: boolean;
  /** lower third を非表示にする (画面共有時など)。 */
  hideLabel?: boolean;
  /** video 要素を子として受ける (composer-template が attach する)。 */
  children: React.ReactNode;
}

/**
 * 視聴者に届く最終画面の 1 タイル。 lower third は半透明黒バーではなく
 * 下→上のグラデ overlay を採用 (Apple Keynote / OBS 流儀)。
 * screen_share の tile は 2px hairline 外枠 + 左上 mono "SCREEN SHARE" ラベル。
 */
export const ParticipantTile = React.forwardRef<HTMLDivElement, ParticipantTileProps>(
  (
    {
      identity,
      name,
      role,
      isTalking,
      isScreenShare,
      showTally = true,
      hideLabel = false,
      children,
      className,
      ...props
    },
    ref,
  ) => (
    <div
      ref={ref}
      data-screen-share={isScreenShare || undefined}
      className={cn(
        "relative overflow-hidden rounded-md bg-surface-2",
        isScreenShare && "ring-2 ring-line-3",
        className,
      )}
      {...props}
    >
      {children}
      {isScreenShare && (
        <span className="absolute left-2 top-2 rounded-sm bg-black/55 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-white/80">
          SCREEN SHARE
        </span>
      )}
      {!hideLabel && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-3 pb-2 pt-8">
          <div className="flex items-end gap-2">
            {showTally && (
              <TallyIndicator state={isTalking ? "on-air" : "idle"} size="sm" pulse={false} />
            )}
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-[15px] font-semibold leading-tight text-white">
                {name ?? identity}
              </span>
              {role && <span className="font-mono text-[11px] text-white/60">{role}</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  ),
);
ParticipantTile.displayName = "ParticipantTile";
