import { Disc, Pause, Play, Tv } from "lucide-react";
import { cn } from "../lib/cn.js";
import { Button } from "../primitives/button.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../primitives/alert-dialog.js";
import { StatusPill } from "./status-pill.js";

export type EgressState = "idle" | "starting" | "active" | "stopping" | "error";

export interface EgressTarget {
  kind: "youtube" | "s3";
  label: string;
}

export interface EgressControlProps {
  state: EgressState;
  targets: EgressTarget[];
  onStart: () => void | Promise<void>;
  onStop: () => void | Promise<void>;
  /** RTMP URL の表示 (任意、 mono で固定幅)。 */
  rtmpUrl?: string;
  className?: string;
}

const stateText: Record<EgressState, string> = {
  idle: "未送出",
  starting: "送出開始中",
  active: "送出中",
  stopping: "停止中",
  error: "エラー",
};

/**
 * Admin サブビュー: YouTube + S3 への Egress 制御。
 * 停止は AlertDialog で二段階確認。
 */
export function EgressControl({
  state,
  targets,
  onStart,
  onStop,
  rtmpUrl,
  className,
}: EgressControlProps) {
  return (
    <section
      className={cn(
        "flex flex-col gap-3 rounded-md border border-line-1 bg-surface-1 p-4",
        className,
      )}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
          Egress (YouTube + S3)
        </h3>
        <StatusPill
          variant={
            state === "active"
              ? "live"
              : state === "error"
                ? "warn"
                : state === "idle"
                  ? "muted"
                  : "loading"
          }
        >
          {stateText[state]}
        </StatusPill>
      </div>
      <ul className="flex flex-wrap gap-2">
        {targets.map((t) => (
          <li
            key={`${t.kind}:${t.label}`}
            className="inline-flex items-center gap-1.5 rounded-full border border-line-2 bg-surface-2 px-2 py-0.5 text-xs text-text-secondary"
          >
            {t.kind === "youtube" ? <Tv className="size-3" /> : <Disc className="size-3" />}
            <span>{t.label}</span>
          </li>
        ))}
      </ul>
      {rtmpUrl && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-text-tertiary">RTMP</span>
          <code className="block truncate rounded border border-line-1 bg-surface-2 px-2 py-1 font-mono text-[11px] text-text-secondary">
            {rtmpUrl}
          </code>
        </div>
      )}
      <div className="flex gap-2">
        {state === "active" || state === "stopping" ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" disabled={state === "stopping"} className="flex-1">
                <Pause className="size-4" />
                Egress 停止
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Egress を停止しますか？</AlertDialogTitle>
                <AlertDialogDescription>
                  YouTube への RTMP 送出を停止します。 視聴者の画面が暗転します。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>キャンセル</AlertDialogCancel>
                <AlertDialogAction onClick={() => void onStop()}>停止する</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : (
          <Button
            variant="default"
            disabled={state !== "idle" && state !== "error"}
            onClick={() => void onStart()}
            className="flex-1"
          >
            <Play className="size-4" />
            Egress 開始
          </Button>
        )}
      </div>
    </section>
  );
}
