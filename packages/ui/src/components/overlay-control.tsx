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

export type OverlayKind = "qr" | "image" | "video";
export type OverlayPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface OverlayControlProps {
  onShow: (opts: {
    kind: OverlayKind;
    url: string;
    position: OverlayPosition;
    sizePercent?: number;
    autoHideMs?: number;
  }) => void;
  onHide: () => void;
  disabled?: boolean;
}

export function OverlayControl({ onShow, onHide, disabled }: OverlayControlProps) {
  const [kind, setKind] = useState<OverlayKind>("qr");
  const [url, setUrl] = useState("");
  const [position, setPosition] = useState<OverlayPosition>("bottom-right");
  const [sizePercent, setSizePercent] = useState(15);
  const [autoHide, setAutoHide] = useState(false);
  const [autoHideSec, setAutoHideSec] = useState(10);

  const handleShow = () => {
    if (!url.trim()) return;
    onShow({
      kind,
      url: url.trim(),
      position,
      sizePercent,
      autoHideMs: autoHide ? autoHideSec * 1000 : undefined,
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-3">
        <div className="grid flex-1 gap-1.5">
          <Label className="text-xs">種別</Label>
          <Select value={kind} onValueChange={(v) => setKind(v as OverlayKind)} disabled={disabled}>
            <SelectTrigger className="h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="qr">QRコード</SelectItem>
              <SelectItem value="image">画像</SelectItem>
              <SelectItem value="video">動画</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid flex-1 gap-1.5">
          <Label className="text-xs">位置</Label>
          <Select
            value={position}
            onValueChange={(v) => setPosition(v as OverlayPosition)}
            disabled={disabled}
          >
            <SelectTrigger className="h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="top-left">左上</SelectItem>
              <SelectItem value="top-right">右上</SelectItem>
              <SelectItem value="bottom-left">左下</SelectItem>
              <SelectItem value="bottom-right">右下</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="overlay-url" className="text-xs">
          URL
        </Label>
        <Input
          id="overlay-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://..."
          className="h-8 text-sm"
          disabled={disabled}
        />
      </div>

      <div className="flex gap-3">
        <div className="grid flex-1 gap-1.5">
          <Label className="text-xs">サイズ (%)</Label>
          <Input
            type="number"
            min={5}
            max={100}
            value={sizePercent}
            onChange={(e) => setSizePercent(Number(e.target.value))}
            className="h-8 text-sm"
            disabled={disabled}
          />
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
                max={120}
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
          disabled={disabled || !url.trim()}
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
