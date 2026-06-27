import { useState } from "react";
import { Button } from "../primitives/button.js";
import { Input } from "../primitives/input.js";
import { Label } from "../primitives/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../primitives/select.js";

export interface BannerControlProps {
  onShow: (opts: {
    text: string;
    subtext?: string;
    position: "bottom" | "top";
    autoHideMs?: number;
  }) => void;
  onHide: () => void;
  disabled?: boolean;
}

export function BannerControl({ onShow, onHide, disabled }: BannerControlProps) {
  const [text, setText] = useState("");
  const [subtext, setSubtext] = useState("");
  const [position, setPosition] = useState<"bottom" | "top">("bottom");
  const [autoHide, setAutoHide] = useState(true);
  const [autoHideSec, setAutoHideSec] = useState(5);

  const handleShow = () => {
    if (!text.trim()) return;
    onShow({
      text: text.trim(),
      subtext: subtext.trim() || undefined,
      position,
      autoHideMs: autoHide ? autoHideSec * 1000 : undefined,
    });
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-1.5">
        <Label htmlFor="banner-text" className="text-xs">
          テキスト
        </Label>
        <Input
          id="banner-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="表示するテキスト"
          className="h-8 text-sm"
          disabled={disabled}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="banner-subtext" className="text-xs">
          サブテキスト（任意）
        </Label>
        <Input
          id="banner-subtext"
          value={subtext}
          onChange={(e) => setSubtext(e.target.value)}
          placeholder="肩書きなど"
          className="h-8 text-sm"
          disabled={disabled}
        />
      </div>

      <div className="flex gap-3">
        <div className="grid flex-1 gap-1.5">
          <Label className="text-xs">位置</Label>
          <Select
            value={position}
            onValueChange={(v) => setPosition(v as "bottom" | "top")}
            disabled={disabled}
          >
            <SelectTrigger className="h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bottom">下部</SelectItem>
              <SelectItem value="top">上部</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid flex-1 gap-1.5">
          <Label className="text-xs">自動非表示</Label>
          <div className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={autoHide}
              onChange={(e) => setAutoHide(e.target.checked)}
              className="size-3.5 rounded border-line-1"
              disabled={disabled}
            />
            {autoHide && (
              <Input
                type="number"
                min={1}
                max={60}
                value={autoHideSec}
                onChange={(e) => setAutoHideSec(Number(e.target.value))}
                className="h-8 w-16 text-sm"
                disabled={disabled}
              />
            )}
            {autoHide && <span className="text-xs text-text-tertiary">秒</span>}
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={handleShow}
          disabled={disabled || !text.trim()}
          className="flex-1"
        >
          表示
        </Button>
        <Button size="sm" variant="outline" onClick={onHide} disabled={disabled} className="flex-1">
          非表示
        </Button>
      </div>
    </div>
  );
}
