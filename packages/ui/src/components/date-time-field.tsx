import * as React from "react";
import { cn } from "../lib/cn.js";
import { Input } from "../primitives/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../primitives/select.js";

/**
 * 日付 + 時刻の入力。時刻は `stepMinutes` 刻みの選択肢しか選べない。
 *
 * ブラウザ標準の datetime-local は `step` をピッカーの見た目に反映しない (Chrome は分の列を
 * 1 分刻みで出す) ので、時と分を Select にした。日付は OS 標準の date 入力のままにする
 * (ローカライズ済みで、モバイルでも扱いやすい)。
 *
 * 値は datetime-local と同じ `YYYY-MM-DDTHH:MM`。日付・時・分のどれかが欠けている間は
 * `""` を返し、必須チェックは呼び出し側に任せる。
 */
export interface DateTimeFieldProps {
  /** 日付入力の id。外側の `<Label htmlFor>` はここに向ける。 */
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** 分の刻み。デフォルト 10。 */
  stepMinutes?: number;
  disabled?: boolean;
  className?: string;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export const HOUR_OPTIONS: readonly string[] = Array.from({ length: 24 }, (_, i) => pad2(i));

export function minuteOptions(stepMinutes: number): string[] {
  return Array.from({ length: Math.floor(60 / stepMinutes) }, (_, i) => pad2(i * stepMinutes));
}

interface Parts {
  date: string;
  hour: string;
  minute: string;
}

/**
 * 刻みに合わない分 (複製元が 09:05 など) はここで捨てる。抱えたままにすると、日付だけ
 * 変えたときに 09:05 を返してしまい、画面からは直せない検証エラーが残る。
 */
function splitValue(value: string, minutes: readonly string[]): Parts {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return { date: "", hour: "", minute: "" };
  const minute = m[3] ?? "";
  return { date: m[1] ?? "", hour: m[2] ?? "", minute: minutes.includes(minute) ? minute : "" };
}

function joinValue(p: Parts): string {
  return p.date && p.hour && p.minute ? `${p.date}T${p.hour}:${p.minute}` : "";
}

export function DateTimeField({
  id,
  value,
  onChange,
  stepMinutes = 10,
  disabled,
  className,
}: DateTimeFieldProps) {
  const minutes = React.useMemo(() => minuteOptions(stepMinutes), [stepMinutes]);
  // 日付だけ・時だけが決まった途中の状態は親には "" で見えるので、部品側で覚えておく。
  const [parts, setParts] = React.useState<Parts>(() => splitValue(value, minutes));
  const emitted = React.useRef(value);
  React.useEffect(() => {
    // 親が別の値を流し込んだとき (複製・リセット) だけ追従する。自分が返した値なら何もしない。
    if (value !== emitted.current) {
      emitted.current = value;
      setParts(splitValue(value, minutes));
    }
  }, [value, minutes]);

  const update = (patch: Partial<Parts>) => {
    const next = { ...parts, ...patch };
    setParts(next);
    const joined = joinValue(next);
    emitted.current = joined;
    onChange(joined);
  };

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Input
        id={id}
        type="date"
        value={parts.date}
        disabled={disabled}
        onChange={(e) => update({ date: e.target.value })}
        className="flex-1"
      />
      <Select value={parts.hour} onValueChange={(hour) => update({ hour })} disabled={disabled}>
        <SelectTrigger aria-label="時" className="w-20">
          <SelectValue placeholder="--" />
        </SelectTrigger>
        <SelectContent>
          {HOUR_OPTIONS.map((h) => (
            <SelectItem key={h} value={h}>
              {h}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-text-tertiary">:</span>
      <Select
        value={parts.minute}
        onValueChange={(minute) => update({ minute })}
        disabled={disabled}
      >
        <SelectTrigger aria-label="分" className="w-20">
          <SelectValue placeholder="--" />
        </SelectTrigger>
        <SelectContent>
          {minutes.map((m) => (
            <SelectItem key={m} value={m}>
              {m}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
