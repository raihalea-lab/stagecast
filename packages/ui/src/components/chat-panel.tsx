import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { cn } from "../lib/cn.js";
import { Button } from "../primitives/button.js";
import { Input } from "../primitives/input.js";

export interface ChatMessageDisplay {
  id: string;
  senderIdentity: string;
  senderName?: string;
  senderRole?: "speaker" | "moderator" | "admin";
  text: string;
  timestampMs: number;
}

export interface ChatPanelProps {
  messages: ChatMessageDisplay[];
  onSend: (text: string) => void;
  currentIdentity: string;
  className?: string;
}

const ROLE_COLORS: Record<string, string> = {
  admin: "text-tally-500",
  moderator: "text-preview-500",
  speaker: "text-text-secondary",
};

const ROLE_LABELS: Record<string, string> = {
  admin: "管理者",
  moderator: "モデレーター",
  speaker: "登壇者",
};

const ROLE_BADGE_COLORS: Record<string, string> = {
  admin: "bg-tally-500/20 text-tally-500",
  moderator: "bg-preview-500/20 text-preview-500",
  speaker: "bg-surface-3 text-text-tertiary",
};

function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function ChatPanel({ messages, onSend, currentIdentity, className }: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const prevLenRef = useRef(messages.length);

  useEffect(() => {
    if (messages.length > prevLenRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
    prevLenRef.current = messages.length;
  }, [messages.length]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  };

  return (
    <div className={cn("flex flex-col rounded-md border border-line-1 bg-surface-1", className)}>
      <div className="border-b border-line-1 px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
          チャット
        </span>
      </div>

      <div
        ref={listRef}
        className="flex-1 overflow-y-auto px-3 py-2"
        style={{ minHeight: 120, maxHeight: 300 }}
      >
        {messages.length === 0 && (
          <p className="py-4 text-center text-xs text-text-tertiary">メッセージはまだありません</p>
        )}
        {messages.map((m) => {
          const isSelf = m.senderIdentity === currentIdentity;
          const role = m.senderRole ?? "speaker";
          const displayName = m.senderName ?? m.senderIdentity;
          return (
            <div key={m.id} className={cn("mb-3 text-sm", isSelf && "text-right")}>
              <div className={cn("flex items-baseline gap-1.5", isSelf && "justify-end")}>
                <span
                  className={cn("font-medium text-xs", ROLE_COLORS[role] ?? "text-text-secondary")}
                >
                  {isSelf ? `${displayName}（自分）` : displayName}
                </span>
                <span
                  className={cn(
                    "rounded px-1 py-0.5 text-[9px] font-medium leading-none",
                    ROLE_BADGE_COLORS[role] ?? "bg-surface-3 text-text-tertiary",
                  )}
                >
                  {ROLE_LABELS[role] ?? role}
                </span>
                <span className="font-mono text-[10px] text-text-tertiary">
                  {formatTime(m.timestampMs)}
                </span>
              </div>
              <p
                className={cn(
                  "mt-0.5 inline-block rounded-lg px-2.5 py-1.5 text-sm",
                  isSelf ? "bg-tally-500/15 text-text-primary" : "bg-surface-2 text-text-primary",
                )}
              >
                {m.text}
              </p>
            </div>
          );
        })}
      </div>

      <div className="flex gap-1.5 border-t border-line-1 px-2 py-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) send();
          }}
          placeholder="メッセージを入力…"
          className="h-8 text-sm"
        />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={send}
          disabled={!draft.trim()}
          aria-label="送信"
        >
          <Send className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
