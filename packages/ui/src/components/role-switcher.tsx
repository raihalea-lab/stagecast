import { cn } from "../lib/cn.js";

export type StageRole = "speaker" | "moderator" | "admin";

export interface RoleSwitcherProps {
  value: StageRole;
  onChange: (next: StageRole) => void;
  /** dev only / admin only であることを視覚的に示す。 */
  experimental?: boolean;
  className?: string;
}

const roles: { value: StageRole; label: string }[] = [
  { value: "speaker", label: "Speaker" },
  { value: "moderator", label: "Moderator" },
  { value: "admin", label: "Admin" },
];

/**
 * Admin が自分の見え方を Speaker / Moderator / Admin で切替てテストする UI。
 * 本番 admin は常時 Admin ビュー、 開発時のみ使う。
 */
export function RoleSwitcher({ value, onChange, experimental, className }: RoleSwitcherProps) {
  return (
    <div
      role="radiogroup"
      aria-label="ロール表示切替"
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-line-2 bg-surface-2 p-0.5",
        className,
      )}
    >
      {experimental && (
        <span className="px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-warning">dev</span>
      )}
      {roles.map((r) => {
        const selected = r.value === value;
        return (
          <button
            key={r.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(r.value)}
            className={cn(
              "rounded-sm px-2 py-1 text-xs transition-colors duration-fast",
              selected
                ? "bg-surface-4 text-text-primary"
                : "text-text-tertiary hover:text-text-secondary",
            )}
          >
            {r.label}
          </button>
        );
      })}
    </div>
  );
}
