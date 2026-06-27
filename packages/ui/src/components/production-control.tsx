import { useState } from "react";
import {
  ChevronUp,
  Image,
  MonitorPlay,
  Play,
  Plus,
  QrCode,
  Square,
  Trash2,
  Type,
} from "lucide-react";
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

interface BannerPreset {
  id: string;
  text: string;
  subtext?: string;
  position: "bottom" | "top";
  autoHideMs?: number;
}

interface OverlayPreset {
  id: string;
  kind: "qr" | "image" | "video";
  label: string;
  url: string;
  position: OverlayPosition;
  sizePercent: number;
  autoHideMs?: number;
}

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

const OVERLAY_KIND_LABEL: Record<string, string> = {
  qr: "QR",
  image: "画像",
  video: "動画",
};

let nextId = 1;
function genId() {
  return `preset-${nextId++}`;
}

export function ProductionControl({
  onShowBanner,
  onHideBanner,
  onShowOverlay,
  onHideOverlay,
  disabled,
}: ProductionControlProps) {
  const [activeTab, setActiveTab] = useState<EffectKind>("banner");
  const [showAddForm, setShowAddForm] = useState(false);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);

  // Presets
  const [bannerPresets, setBannerPresets] = useState<BannerPreset[]>([]);
  const [overlayPresets, setOverlayPresets] = useState<OverlayPreset[]>([]);

  // Banner add form
  const [bText, setBText] = useState("");
  const [bSub, setBSub] = useState("");
  const [bPos, setBPos] = useState<"bottom" | "top">("bottom");
  const [bAutoHide, setBAutoHide] = useState(true);
  const [bAutoSec, setBAutoSec] = useState(5);

  // Overlay add form
  const [oLabel, setOLabel] = useState("");
  const [oUrl, setOUrl] = useState("");
  const [oPos, setOPos] = useState<OverlayPosition>("bottom-right");
  const [oSize, setOSize] = useState(15);
  const [oAutoHide, setOAutoHide] = useState(false);
  const [oAutoSec, setOAutoSec] = useState(10);

  const addBanner = () => {
    if (!bText.trim()) return;
    setBannerPresets((prev) => [
      ...prev,
      {
        id: genId(),
        text: bText.trim(),
        subtext: bSub.trim() || undefined,
        position: bPos,
        autoHideMs: bAutoHide ? bAutoSec * 1000 : undefined,
      },
    ]);
    setBText("");
    setBSub("");
    setShowAddForm(false);
  };

  const addOverlay = () => {
    if (!oUrl.trim()) return;
    const kind = activeTab as "qr" | "image" | "video";
    setOverlayPresets((prev) => [
      ...prev,
      {
        id: genId(),
        kind,
        label: oLabel.trim() || oUrl.trim().split("/").pop() || kind,
        url: oUrl.trim(),
        position: oPos,
        sizePercent: oSize,
        autoHideMs: oAutoHide ? oAutoSec * 1000 : undefined,
      },
    ]);
    setOLabel("");
    setOUrl("");
    setShowAddForm(false);
  };

  const showBannerPreset = (p: BannerPreset) => {
    setActivePresetId(p.id);
    onShowBanner({
      text: p.text,
      subtext: p.subtext,
      position: p.position,
      autoHideMs: p.autoHideMs,
    });
  };

  const showOverlayPreset = (p: OverlayPreset) => {
    setActivePresetId(p.id);
    onShowOverlay({
      kind: p.kind,
      url: p.url,
      position: p.position,
      sizePercent: p.sizePercent,
      autoHideMs: p.autoHideMs,
    });
  };

  const handleHide = () => {
    setActivePresetId(null);
    if (activeTab === "banner") {
      onHideBanner();
    } else {
      onHideOverlay();
    }
  };

  const filteredOverlays = overlayPresets.filter(
    (p) => p.kind === activeTab,
  );

  const currentPresets =
    activeTab === "banner" ? bannerPresets : filteredOverlays;
  const hasActive = activePresetId !== null;

  return (
    <div className="space-y-3">
      {/* Effect type selector */}
      <div className="flex gap-1 rounded-lg bg-surface-2 p-1">
        {EFFECT_ITEMS.map(({ kind, icon: Icon, label }) => {
          const count =
            kind === "banner"
              ? bannerPresets.length
              : overlayPresets.filter((p) => p.kind === kind).length;
          return (
            <button
              key={kind}
              type="button"
              onClick={() => {
                setActiveTab(kind);
                setShowAddForm(false);
              }}
              disabled={disabled}
              className={cn(
                "flex flex-1 flex-col items-center gap-0.5 rounded-md px-2 py-1.5 text-[10px] font-medium transition-colors",
                activeTab === kind
                  ? "bg-surface-1 text-text-primary shadow-sm"
                  : "text-text-tertiary hover:text-text-secondary",
                disabled && "opacity-40 cursor-not-allowed",
              )}
            >
              <div className="relative">
                <Icon className="size-4" />
                {count > 0 && (
                  <span className="absolute -right-2 -top-1.5 flex size-3.5 items-center justify-center rounded-full bg-tally-500 text-[8px] font-bold text-white">
                    {count}
                  </span>
                )}
              </div>
              {label}
            </button>
          );
        })}
      </div>

      {/* Preset list */}
      {currentPresets.length > 0 && (
        <div className="space-y-1">
          {activeTab === "banner"
            ? bannerPresets.map((p) => (
                <div
                  key={p.id}
                  className={cn(
                    "group flex items-center gap-2 rounded-md border px-2.5 py-1.5 transition-colors",
                    activePresetId === p.id
                      ? "border-tally-500/50 bg-tally-500/10"
                      : "border-line-1 bg-surface-1 hover:bg-surface-2",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text-primary">
                      {p.text}
                    </p>
                    {p.subtext && (
                      <p className="truncate text-xs text-text-tertiary">
                        {p.subtext}
                      </p>
                    )}
                  </div>
                  <Button
                    size="icon-sm"
                    variant={
                      activePresetId === p.id ? "default" : "outline"
                    }
                    onClick={() => showBannerPreset(p)}
                    disabled={disabled}
                    aria-label="表示"
                    className="shrink-0"
                  >
                    <Play className="size-3" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() =>
                      setBannerPresets((prev) =>
                        prev.filter((x) => x.id !== p.id),
                      )
                    }
                    disabled={disabled}
                    aria-label="削除"
                    className="shrink-0 opacity-0 group-hover:opacity-100"
                  >
                    <Trash2 className="size-3 text-text-tertiary" />
                  </Button>
                </div>
              ))
            : filteredOverlays.map((p) => (
                <div
                  key={p.id}
                  className={cn(
                    "group flex items-center gap-2 rounded-md border px-2.5 py-1.5 transition-colors",
                    activePresetId === p.id
                      ? "border-tally-500/50 bg-tally-500/10"
                      : "border-line-1 bg-surface-1 hover:bg-surface-2",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text-primary">
                      {p.label}
                    </p>
                    <p className="truncate text-xs text-text-tertiary">
                      {OVERLAY_KIND_LABEL[p.kind]} · {p.sizePercent}%
                    </p>
                  </div>
                  <Button
                    size="icon-sm"
                    variant={
                      activePresetId === p.id ? "default" : "outline"
                    }
                    onClick={() => showOverlayPreset(p)}
                    disabled={disabled}
                    aria-label="表示"
                    className="shrink-0"
                  >
                    <Play className="size-3" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() =>
                      setOverlayPresets((prev) =>
                        prev.filter((x) => x.id !== p.id),
                      )
                    }
                    disabled={disabled}
                    aria-label="削除"
                    className="shrink-0 opacity-0 group-hover:opacity-100"
                  >
                    <Trash2 className="size-3 text-text-tertiary" />
                  </Button>
                </div>
              ))}
        </div>
      )}

      {/* Hide button */}
      {hasActive && (
        <Button
          size="sm"
          variant="outline"
          onClick={handleHide}
          disabled={disabled}
          className="w-full"
        >
          <Square className="mr-1.5 size-3" />
          非表示
        </Button>
      )}

      {/* Empty state */}
      {currentPresets.length === 0 && !showAddForm && (
        <p className="py-2 text-center text-xs text-text-tertiary">
          プリセットがありません
        </p>
      )}

      {/* Add form toggle */}
      <button
        type="button"
        onClick={() => setShowAddForm(!showAddForm)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
      >
        {showAddForm ? (
          <ChevronUp className="size-3.5" />
        ) : (
          <Plus className="size-3.5" />
        )}
        {showAddForm ? "閉じる" : "新規追加"}
      </button>

      {/* Banner add form */}
      {showAddForm && activeTab === "banner" && (
        <div className="space-y-2 rounded-md border border-line-1 bg-surface-2 p-3">
          <div className="grid gap-1">
            <Label className="text-xs">テキスト</Label>
            <Input
              value={bText}
              onChange={(e) => setBText(e.target.value)}
              placeholder="登壇者名やお知らせ"
              className="h-7 text-sm"
              disabled={disabled}
            />
          </div>
          <div className="grid gap-1">
            <Label className="text-xs">サブテキスト</Label>
            <Input
              value={bSub}
              onChange={(e) => setBSub(e.target.value)}
              placeholder="肩書き（任意）"
              className="h-7 text-sm"
              disabled={disabled}
            />
          </div>
          <div className="flex gap-2">
            <div className="grid flex-1 gap-1">
              <Label className="text-xs">位置</Label>
              <Select
                value={bPos}
                onValueChange={(v) => setBPos(v as "bottom" | "top")}
                disabled={disabled}
              >
                <SelectTrigger className="h-7 text-sm">
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
              <div className="flex h-7 items-center gap-1">
                <input
                  type="checkbox"
                  checked={bAutoHide}
                  onChange={(e) => setBAutoHide(e.target.checked)}
                  className="size-3.5 rounded border-line-1"
                  disabled={disabled}
                />
                {bAutoHide && (
                  <>
                    <Input
                      type="number"
                      min={1}
                      max={60}
                      value={bAutoSec}
                      onChange={(e) => setBAutoSec(Number(e.target.value))}
                      className="h-7 w-12 text-xs"
                      disabled={disabled}
                    />
                    <span className="text-[10px] text-text-tertiary">秒</span>
                  </>
                )}
              </div>
            </div>
          </div>
          <Button
            size="sm"
            onClick={addBanner}
            disabled={disabled || !bText.trim()}
            className="w-full"
          >
            <Plus className="mr-1 size-3.5" />
            追加
          </Button>
        </div>
      )}

      {/* Overlay add form (QR / Image / Video) */}
      {showAddForm && activeTab !== "banner" && (
        <div className="space-y-2 rounded-md border border-line-1 bg-surface-2 p-3">
          <div className="grid gap-1">
            <Label className="text-xs">ラベル</Label>
            <Input
              value={oLabel}
              onChange={(e) => setOLabel(e.target.value)}
              placeholder="表示名（任意）"
              className="h-7 text-sm"
              disabled={disabled}
            />
          </div>
          <div className="grid gap-1">
            <Label className="text-xs">URL</Label>
            <Input
              value={oUrl}
              onChange={(e) => setOUrl(e.target.value)}
              placeholder="https://..."
              className="h-7 text-sm"
              disabled={disabled}
            />
          </div>
          <div className="flex gap-2">
            <div className="grid flex-1 gap-1">
              <Label className="text-xs">位置</Label>
              <Select
                value={oPos}
                onValueChange={(v) => setOPos(v as OverlayPosition)}
                disabled={disabled}
              >
                <SelectTrigger className="h-7 text-sm">
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
              <div className="flex h-7 items-center gap-1">
                <Input
                  type="number"
                  min={5}
                  max={100}
                  value={oSize}
                  onChange={(e) => setOSize(Number(e.target.value))}
                  className="h-7 w-12 text-xs"
                  disabled={disabled}
                />
                <span className="text-[10px] text-text-tertiary">%</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={oAutoHide}
              onChange={(e) => setOAutoHide(e.target.checked)}
              className="size-3.5 rounded border-line-1"
              disabled={disabled}
            />
            <span className="text-xs text-text-secondary">自動非表示</span>
            {oAutoHide && (
              <>
                <Input
                  type="number"
                  min={1}
                  max={120}
                  value={oAutoSec}
                  onChange={(e) => setOAutoSec(Number(e.target.value))}
                  className="h-7 w-12 text-xs"
                  disabled={disabled}
                />
                <span className="text-[10px] text-text-tertiary">秒</span>
              </>
            )}
          </div>
          <Button
            size="sm"
            onClick={addOverlay}
            disabled={disabled || !oUrl.trim()}
            className="w-full"
          >
            <Plus className="mr-1 size-3.5" />
            追加
          </Button>
        </div>
      )}
    </div>
  );
}
