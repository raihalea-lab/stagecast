import * as React from "react";
import { Moon, Monitor, Sun } from "lucide-react";
import { cn } from "../lib/cn.js";

export type ThemeMode = "light" | "dark" | "system";

export interface ThemeToggleProps {
  value: ThemeMode;
  onChange: (next: ThemeMode) => void;
  className?: string;
}

const modes: { value: ThemeMode; label: string; icon: React.ReactNode }[] = [
  { value: "light", label: "ライト", icon: <Sun className="size-3.5" /> },
  { value: "dark", label: "ダーク", icon: <Moon className="size-3.5" /> },
  {
    value: "system",
    label: "システム",
    icon: <Monitor className="size-3.5" />,
  },
];

/**
 * 3 値テーマトグル。 admin-web のサイドバー下部に置く。
 */
export function ThemeToggle({ value, onChange, className }: ThemeToggleProps) {
  return (
    <div
      role="radiogroup"
      aria-label="テーマ"
      className={cn(
        "inline-flex items-center rounded-md border border-line-1 bg-surface-2 p-0.5",
        className,
      )}
    >
      {modes.map((m) => {
        const selected = value === m.value;
        return (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={m.label}
            onClick={() => onChange(m.value)}
            className={cn(
              "inline-flex items-center justify-center rounded-sm px-2 py-1 transition-colors duration-fast",
              selected
                ? "bg-surface-4 text-text-primary"
                : "text-text-tertiary hover:text-text-secondary",
            )}
          >
            {m.icon}
          </button>
        );
      })}
    </div>
  );
}
