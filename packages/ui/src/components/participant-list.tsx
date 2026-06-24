import { Mic, MicOff, ScreenShare, Star } from "lucide-react";
import { cn } from "../lib/cn.js";
import { TallyIndicator } from "./tally-indicator.js";
import { MonoNumber } from "./mono-number.js";

/**
 * 抽象的な participant 情報。 livekit-client への結合を packages/ui に持ち込まないため
 * stage-web 側で Participant → ParticipantInfo に詰め替えて渡す。
 */
export interface ParticipantInfo {
  identity: string;
  name?: string;
  role?: "speaker" | "moderator" | "admin";
  isTalking: boolean;
  isMuted: boolean;
  isScreenSharing: boolean;
}

export interface ParticipantListProps {
  participants: ParticipantInfo[];
  /** 現在 focus 指定中の identity。 */
  focusIdentity?: string;
  onFocus?: (identity: string) => void;
  /** モデレーター/admin からのミュート要請 (DataChannel)。 */
  onRequestMute?: (identity: string) => void;
  className?: string;
}

/**
 * Moderator / Admin 向け参加者表。 各行に focus 指定とミュート要請ボタン。
 */
export function ParticipantList({
  participants,
  focusIdentity,
  onFocus,
  onRequestMute,
  className,
}: ParticipantListProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-0.5 rounded-md border border-line-1 bg-surface-1",
        className,
      )}
    >
      <div className="flex items-center justify-between border-b border-line-1 px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
          参加者
        </span>
        <MonoNumber value={participants.length} tone="secondary" width={2} className="text-xs" />
      </div>
      <ul className="divide-y divide-line-1">
        {participants.map((p) => {
          const isFocus = p.identity === focusIdentity;
          return (
            <li key={p.identity} className="flex items-center gap-2 px-3 py-2">
              <TallyIndicator
                state={p.isTalking ? "on-air" : "idle"}
                size="sm"
                pulse={false}
                label={p.isTalking ? "発話中" : "静音"}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm text-text-primary">{p.name ?? p.identity}</span>
                <span className="font-mono text-[10px] text-text-tertiary">
                  {p.role ?? "speaker"} / {p.identity}
                </span>
              </span>
              {p.isScreenSharing && (
                <ScreenShare className="size-3.5 text-preview-500" aria-label="画面共有中" />
              )}
              {p.isMuted ? (
                <MicOff className="size-3.5 text-text-tertiary" aria-label="ミュート中" />
              ) : (
                <Mic className="size-3.5 text-text-secondary" aria-label="マイク ON" />
              )}
              <button
                type="button"
                onClick={() => onFocus?.(p.identity)}
                aria-pressed={isFocus}
                aria-label={isFocus ? "focus 解除" : "focus 指定"}
                className={cn(
                  "rounded p-1 transition-colors duration-fast",
                  isFocus ? "text-preview-500" : "text-text-tertiary hover:text-text-primary",
                )}
              >
                <Star className="size-3.5" />
              </button>
              {onRequestMute && !p.isMuted && (
                <button
                  type="button"
                  onClick={() => onRequestMute(p.identity)}
                  aria-label="ミュート要請"
                  className="rounded p-1 text-text-tertiary transition-colors duration-fast hover:text-warning"
                >
                  <MicOff className="size-3.5" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
