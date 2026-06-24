import { Radio, Square } from "lucide-react";
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
import { MonoNumber } from "./mono-number.js";

export type RoomState = "stopped" | "starting" | "running" | "stopping" | "error";

export interface LifecycleControlProps {
  state: RoomState;
  /** イベント経過秒 (running 中のみ表示)。 */
  elapsedSec?: number;
  participantCount?: number;
  onEnd: () => void | Promise<void>;
  className?: string;
}

const stateText: Record<RoomState, string> = {
  stopped: "停止中",
  starting: "起動中",
  running: "稼働中",
  stopping: "停止処理中",
  error: "エラー",
};

/**
 * Admin サブビュー: LiveKit room の起動状態と「配信終了」ボタン。
 * 終了は AlertDialog で二段階確認 (取り返しがつかない操作のため)。
 */
export function LifecycleControl({
  state,
  elapsedSec,
  participantCount,
  onEnd,
  className,
}: LifecycleControlProps) {
  return (
    <section
      className={cn(
        "flex flex-col gap-3 rounded-md border border-line-1 bg-surface-1 p-4",
        className,
      )}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
          配信ライフサイクル
        </h3>
        <StatusPill
          variant={
            state === "running"
              ? "live"
              : state === "error"
                ? "warn"
                : state === "stopped" || state === "stopping"
                  ? "muted"
                  : "loading"
          }
        >
          {stateText[state]}
        </StatusPill>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-text-tertiary">経過</span>
          <MonoNumber value={elapsedSec ?? 0} unit="s" width={4} tone="primary" align="left" />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-text-tertiary">参加者</span>
          <MonoNumber value={participantCount ?? 0} width={2} tone="primary" align="left" />
        </div>
      </div>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="destructive" disabled={state !== "running"} className="w-full">
            {state === "running" ? (
              <>
                <Square className="size-4" />
                配信終了
              </>
            ) : (
              <>
                <Radio className="size-4" />
                {stateText[state]}
              </>
            )}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>配信を終了しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              LiveKit room を解散し、 メディアスタックを破棄します。 やり直しは できません
              (再起動には数十秒かかります)。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onEnd()}>終了する</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
