import { useState } from "react";
import { Image, MonitorPlay, QrCode, Type, X } from "lucide-react";
import { cn } from "../lib/cn.js";
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

type EffectKind = "banner" | "qr" | "image" | "video";
type OverlayPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface ProductionControlProps {
  onShowBanner: (opts: {
    text: string;
    subtext?: string;
    position: "bottom" | "top";
    autoHideMs?: number;
  }) => void;
  onHideBanner: () => void;
  onShowOverlay: (opts: {
    kind: "qr" | "image" | "video";
    url: string;
    position: OverlayPosition;
    sizePercent?: number;
    autoHideMs?: number;
  }) => void;
  onHideOverlay: () => void;
  disabled?: boolean;
}

const EFFECT_ITEMS: {
  kind: EffectKind;
  icon: typeof Type;
  label: string;
}[] = [
  { kind: "banner", icon: Type, label: "バナー" },
  { kind: "qr", icon: QrCode, label: "QR" },
  { kind: "image", icon: Image, label: "画像" },
  { kind: "video", icon: MonitorPlay, label: "動画" },
];

export function ProductionControl({
  onShowBanner,
  onHideBanner,
  onShowOverlay,
  onHideOverlay,
  disabled,
}: ProductionControlProps) {
  const [active, setActive] = useState<EffectKind>("banner");

  // Banner state
  const [bannerText, setBannerText] = useState("");
  const [bannerSubtext, setBannerSubtext] = useState("");
  const [bannerPosition, setBannerPosition] = useState<"bottom" | "top">(
    "bottom",
  );
  const [bannerAutoHide, setBannerAutoHide] = useState(true);
  const [bannerAutoHideSec, setBannerAutoHideSec] = useState(5);

  // Overlay state (shared for qr/image/video)
  const [overlayUrl, setOverlayUrl] = useState("");
  const [overlayPosition, setOverlayPosition] =
    useState<OverlayPosition>("bottom-right");
  const [overlaySizePercent, setOverlaySizePercent] = useState(15);
  const [overlayAutoHide, setOverlayAutoHide] = useState(false);
  const [overlayAutoHideSec, setOverlayAutoHideSec] = useState(10);

  const handleShowBanner = () => {
    if (!bannerText.trim()) return;
    onShowBanner({
      text: bannerText.trim(),
      subtext: bannerSubtext.trim() || undefined,
      position: bannerPosition,
      autoHideMs: bannerAutoHide ? bannerAutoHideSec * 1000 : undefined,
    });
  };

  const handleShowOverlay = () => {
    if (!overlayUrl.trim()) return;
    onShowOverlay({
      kind: active as "qr" | "image" | "video",
      url: overlayUrl.trim(),
      position: overlayPosition,
      sizePercent: overlaySizePercent,
      autoHideMs: overlayAutoHide ? overlayAutoHideSec * 1000 : undefined,
    });
  };

  return (
    <div className="space-y-3">
      {/* Effect type selector */}
      <div className="flex gap-1 rounded-lg bg-surface-2 p-1">
        {EFFECT_ITEMS.map(({ kind, icon: Icon, label }) => (
          <button
            key={kind}
            type="button"
            onClick={() => setActive(kind)}
            disabled={disabled}
            className={cn(
              "flex flex-1 flex-col items-center gap-0.5 rounded-md px-2 py-1.5 text-[10px] font-medium transition-colors",
              active === kind
                ? "bg-surface-1 text-text-primary shadow-sm"
                : "text-text-tertiary hover:text-text-secondary",
              disabled && "opacity-40 cursor-not-allowed",
            )}
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
      </div>

      {/* Banner form */}
      {active === "banner" && (
        <div className="space-y-2.5">
          <div className="grid gap-1">
            <Label htmlFor="pc-banner-text" className="text-xs">
              テキスト
            </Label>
            <Input
              id="pc-banner-text"
              value={bannerText}
              onChange={(e) => setBannerText(e.target.value)}
              placeholder="登壇者名やお知らせ"
              className="h-8 text-sm"
              disabled={disabled}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="pc-banner-sub" className="text-xs">
              サブテキスト
            </Label>
            <Input
              id="pc-banner-sub"
              value={bannerSubtext}
              onChange={(e) => setBannerSubtext(e.target.value)}
              placeholder="肩書き（任意）"
              className="h-8 text-sm"
              disabled={disabled}
            />
          </div>
          <div className="flex gap-2">
            <div className="grid flex-1 gap-1">
              <Label className="text-xs">位置</Label>
              <Select
                value={bannerPosition}
                onValueChange={(v) =>
                  setBannerPosition(v as "bottom" | "top")
                }
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
            <div className="grid flex-1 gap-1">
              <Label className="text-xs">自動非表示</Label>
              <div className="flex h-8 items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={bannerAutoHide}
                  onChange={(e) => setBannerAutoHide(e.target.checked)}
                  className="size-3.5 rounded border-line-1"
                  disabled={disabled}
                />
                {bannerAutoHide && (
                  <>
                    <Input
                      type="number"
                      min={1}
                      max={60}
                      value={bannerAutoHideSec}
                      onChange={(e) =>
                        setBannerAutoHideSec(Number(e.target.value))
                      }
                      className="h-8 w-14 text-sm"
                      disabled={disabled}
                    />
                    <span className="text-xs text-text-tertiary">秒</span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={handleShowBanner}
              disabled={disabled || !bannerText.trim()}
              className="flex-1"
            >
              <Type className="mr-1 size-3.5" />
              表示
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onHideBanner}
              disabled={disabled}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* Overlay form (QR / Image / Video) */}
      {active !== "banner" && (
        <div className="space-y-2.5">
          <div className="grid gap-1">
            <Label htmlFor="pc-overlay-url" className="text-xs">
              {active === "qr"
                ? "QRコードのURL"
                : active === "image"
                  ? "画像URL"
                  : "動画URL"}
            </Label>
            <Input
              id="pc-overlay-url"
              value={overlayUrl}
              onChange={(e) => setOverlayUrl(e.target.value)}
              placeholder="https://..."
              className="h-8 text-sm"
              disabled={disabled}
            />
          </div>
          <div className="flex gap-2">
            <div className="grid flex-1 gap-1">
              <Label className="text-xs">位置</Label>
              <Select
                value={overlayPosition}
                onValueChange={(v) =>
                  setOverlayPosition(v as OverlayPosition)
                }
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
            <div className="grid flex-1 gap-1">
              <Label className="text-xs">サイズ</Label>
              <div className="flex h-8 items-center gap-1.5">
                <Input
                  type="number"
                  min={5}
                  max={100}
                  value={overlaySizePercent}
                  onChange={(e) =>
                    setOverlaySizePercent(Number(e.target.value))
                  }
                  className="h-8 w-14 text-sm"
                  disabled={disabled}
                />
                <span className="text-xs text-text-tertiary">%</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={overlayAutoHide}
              onChange={(e) => setOverlayAutoHide(e.target.checked)}
              className="size-3.5 rounded border-line-1"
              disabled={disabled}
            />
            <span className="text-xs text-text-secondary">自動非表示</span>
            {overlayAutoHide && (
              <>
                <Input
                  type="number"
                  min={1}
                  max={120}
                  value={overlayAutoHideSec}
                  onChange={(e) =>
                    setOverlayAutoHideSec(Number(e.target.value))
                  }
                  className="h-8 w-14 text-sm"
                  disabled={disabled}
                />
                <span className="text-xs text-text-tertiary">秒</span>
              </>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={handleShowOverlay}
              disabled={disabled || !overlayUrl.trim()}
              className="flex-1"
            >
              {active === "qr" && <QrCode className="mr-1 size-3.5" />}
              {active === "image" && <Image className="mr-1 size-3.5" />}
              {active === "video" && (
                <MonitorPlay className="mr-1 size-3.5" />
              )}
              表示
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onHideOverlay}
              disabled={disabled}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
