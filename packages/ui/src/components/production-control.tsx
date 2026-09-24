import { useCallback, useMemo, useState } from "react";
import type { AssetMetadata, EffectConfig, Preset } from "@stagecast/shared";
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
  Upload,
} from "lucide-react";
import { cn } from "../lib/cn.js";
import { Button } from "../primitives/button.js";
import { Checkbox } from "../primitives/checkbox.js";
import { Input } from "../primitives/input.js";
import { Label } from "../primitives/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../primitives/select.js";

type EffectKind = EffectConfig["kind"];
type OverlayPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface ProductionControlProps {
  presets: Preset[];
  assets: AssetMetadata[];
  onCreatePreset: (label: string, config: EffectConfig) => void;
  onDeletePreset: (presetId: string) => void;
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
  onResolveAssetUrl: (assetKey: string) => Promise<string>;
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

const KIND_LABEL: Record<string, string> = {
  banner: "バナー",
  qr: "QR",
  image: "画像",
  video: "動画",
};

function presetLabel(p: Preset): string {
  if (p.label) return p.label;
  const c = p.config;
  if (c.kind === "banner") return c.text;
  if (c.kind === "qr") return c.url;
  return c.label;
}

function presetSubLabel(p: Preset): string | undefined {
  const c = p.config;
  if (c.kind === "banner") return c.subtext;
  return `${KIND_LABEL[c.kind]} · ${c.sizePercent ?? 15}%`;
}

function PositionSelect({
  value,
  onChange,
  disabled,
}: {
  value: OverlayPosition;
  onChange: (v: OverlayPosition) => void;
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as OverlayPosition)} disabled={disabled}>
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
  );
}

function SizeInput({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex h-7 items-center gap-1">
      <Input
        type="number"
        min={5}
        max={100}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-7 w-12 text-xs"
        disabled={disabled}
      />
      <span className="text-[10px] text-text-tertiary">%</span>
    </div>
  );
}

function AutoHideInput({
  enabled,
  seconds,
  onEnabledChange,
  onSecondsChange,
  disabled,
  maxSec = 120,
}: {
  enabled: boolean;
  seconds: number;
  onEnabledChange: (v: boolean) => void;
  onSecondsChange: (v: number) => void;
  disabled?: boolean;
  maxSec?: number;
}) {
  return (
    <div className="flex items-center gap-1">
      <Checkbox
        checked={enabled}
        onChange={(e) => onEnabledChange(e.target.checked)}
        className="size-3.5"
        disabled={disabled}
      />
      <span className="text-xs text-text-secondary">自動非表示</span>
      {enabled && (
        <>
          <Input
            type="number"
            min={1}
            max={maxSec}
            value={seconds}
            onChange={(e) => onSecondsChange(Number(e.target.value))}
            className="h-7 w-12 text-xs"
            disabled={disabled}
          />
          <span className="text-[10px] text-text-tertiary">秒</span>
        </>
      )}
    </div>
  );
}

function AssetPicker({
  assets,
  selectedKey,
  onSelect,
  accept,
  disabled,
}: {
  assets: AssetMetadata[];
  selectedKey: string;
  onSelect: (key: string, label: string) => void;
  accept: string[];
  disabled?: boolean;
}) {
  const [tagFilter, setTagFilter] = useState("");

  const filtered = useMemo(() => {
    let list = assets.filter((a) => accept.some((t) => a.contentType.startsWith(t)));
    if (tagFilter) {
      list = list.filter((a) => a.tags.includes(tagFilter));
    }
    return list;
  }, [assets, accept, tagFilter]);

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const a of assets) {
      for (const t of a.tags) tags.add(t);
    }
    return [...tags].sort();
  }, [assets]);

  return (
    <div className="space-y-1.5">
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => setTagFilter("")}
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors",
              !tagFilter
                ? "bg-tally-500 text-white"
                : "bg-surface-3 text-text-tertiary hover:text-text-secondary",
            )}
          >
            全て
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => setTagFilter(tagFilter === tag ? "" : tag)}
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors",
                tagFilter === tag
                  ? "bg-tally-500 text-white"
                  : "bg-surface-3 text-text-tertiary hover:text-text-secondary",
              )}
            >
              {tag}
            </button>
          ))}
        </div>
      )}
      {filtered.length === 0 ? (
        <p className="py-2 text-center text-xs text-text-tertiary">
          {assets.length === 0
            ? "アセットがありません（管理画面からアップロード）"
            : "該当するアセットがありません"}
        </p>
      ) : (
        <div className="max-h-32 space-y-0.5 overflow-y-auto">
          {filtered.map((a) => (
            <button
              key={a.assetId}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(a.assetKey, a.filename)}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors",
                selectedKey === a.assetKey
                  ? "bg-tally-500/10 text-tally-500"
                  : "text-text-secondary hover:bg-surface-2",
              )}
            >
              <Upload className="size-3 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{a.filename}</span>
              {a.tags.length > 0 && (
                <span className="shrink-0 text-[9px] text-text-tertiary">{a.tags.join(", ")}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface FormSubmitProps {
  onSubmit: (label: string, config: EffectConfig) => void;
  assets: AssetMetadata[];
  disabled?: boolean;
}

function BannerForm({ onSubmit, disabled }: FormSubmitProps) {
  const [text, setText] = useState("");
  const [sub, setSub] = useState("");
  const [pos, setPos] = useState<"bottom" | "top">("bottom");
  const [autoHide, setAutoHide] = useState(true);
  const [autoSec, setAutoSec] = useState(5);

  const submit = () => {
    if (!text.trim()) return;
    onSubmit(text.trim(), {
      kind: "banner",
      text: text.trim(),
      subtext: sub.trim() || undefined,
      position: pos,
      autoHideMs: autoHide ? autoSec * 1000 : undefined,
    });
    setText("");
    setSub("");
  };

  return (
    <div className="space-y-2">
      <div className="grid gap-1">
        <Label className="text-xs">テキスト</Label>
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="登壇者名やお知らせ"
          className="h-7 text-sm"
          disabled={disabled}
        />
      </div>
      <div className="grid gap-1">
        <Label className="text-xs">サブテキスト</Label>
        <Input
          value={sub}
          onChange={(e) => setSub(e.target.value)}
          placeholder="肩書き（任意）"
          className="h-7 text-sm"
          disabled={disabled}
        />
      </div>
      <div className="flex gap-2">
        <div className="grid flex-1 gap-1">
          <Label className="text-xs">位置</Label>
          <Select
            value={pos}
            onValueChange={(v) => setPos(v as "bottom" | "top")}
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
          <AutoHideInput
            enabled={autoHide}
            seconds={autoSec}
            onEnabledChange={setAutoHide}
            onSecondsChange={setAutoSec}
            disabled={disabled}
            maxSec={60}
          />
        </div>
      </div>
      <Button size="sm" onClick={submit} disabled={disabled || !text.trim()} className="w-full">
        <Plus className="mr-1 size-3.5" />
        追加
      </Button>
    </div>
  );
}

function QrForm({ onSubmit, disabled }: FormSubmitProps) {
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [pos, setPos] = useState<OverlayPosition>("bottom-right");
  const [size, setSize] = useState(15);
  const [autoHide, setAutoHide] = useState(false);
  const [autoSec, setAutoSec] = useState(10);

  const submit = () => {
    if (!url.trim()) return;
    onSubmit(label.trim() || url.trim(), {
      kind: "qr",
      url: url.trim(),
      position: pos,
      sizePercent: size,
      autoHideMs: autoHide ? autoSec * 1000 : undefined,
    });
    setLabel("");
    setUrl("");
  };

  return (
    <div className="space-y-2">
      <div className="grid gap-1">
        <Label className="text-xs">ラベル</Label>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="表示名（任意）"
          className="h-7 text-sm"
          disabled={disabled}
        />
      </div>
      <div className="grid gap-1">
        <Label className="text-xs">URL</Label>
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://..."
          className="h-7 text-sm"
          disabled={disabled}
        />
      </div>
      <div className="flex gap-2">
        <div className="grid flex-1 gap-1">
          <Label className="text-xs">位置</Label>
          <PositionSelect value={pos} onChange={setPos} disabled={disabled} />
        </div>
        <div className="grid flex-1 gap-1">
          <Label className="text-xs">サイズ</Label>
          <SizeInput value={size} onChange={setSize} disabled={disabled} />
        </div>
      </div>
      <AutoHideInput
        enabled={autoHide}
        seconds={autoSec}
        onEnabledChange={setAutoHide}
        onSecondsChange={setAutoSec}
        disabled={disabled}
      />
      <Button size="sm" onClick={submit} disabled={disabled || !url.trim()} className="w-full">
        <Plus className="mr-1 size-3.5" />
        追加
      </Button>
    </div>
  );
}

function AssetOverlayForm({
  kind,
  onSubmit,
  assets,
  disabled,
}: FormSubmitProps & { kind: "image" | "video" }) {
  const [assetKey, setAssetKey] = useState("");
  const [label, setLabel] = useState("");
  const [pos, setPos] = useState<OverlayPosition>("bottom-right");
  const [size, setSize] = useState(kind === "video" ? 100 : 20);
  const [autoHide, setAutoHide] = useState(false);
  const [autoSec, setAutoSec] = useState(10);

  const acceptTypes = kind === "image" ? ["image/"] : ["video/"];

  const submit = () => {
    if (!assetKey) return;
    onSubmit(label.trim() || assetKey.split("/").pop() || kind, {
      kind,
      assetKey,
      label: label.trim() || assetKey.split("/").pop() || kind,
      position: pos,
      sizePercent: size,
      autoHideMs: autoHide ? autoSec * 1000 : undefined,
    });
    setAssetKey("");
    setLabel("");
  };

  return (
    <div className="space-y-2">
      <div className="grid gap-1">
        <Label className="text-xs">ラベル</Label>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="表示名（任意）"
          className="h-7 text-sm"
          disabled={disabled}
        />
      </div>
      <div className="grid gap-1">
        <Label className="text-xs">アセット</Label>
        <AssetPicker
          assets={assets}
          selectedKey={assetKey}
          onSelect={(key, name) => {
            setAssetKey(key);
            if (!label.trim()) setLabel(name);
          }}
          accept={acceptTypes}
          disabled={disabled}
        />
      </div>
      <div className="flex gap-2">
        <div className="grid flex-1 gap-1">
          <Label className="text-xs">位置</Label>
          <PositionSelect value={pos} onChange={setPos} disabled={disabled} />
        </div>
        <div className="grid flex-1 gap-1">
          <Label className="text-xs">サイズ</Label>
          <SizeInput value={size} onChange={setSize} disabled={disabled} />
        </div>
      </div>
      <AutoHideInput
        enabled={autoHide}
        seconds={autoSec}
        onEnabledChange={setAutoHide}
        onSecondsChange={setAutoSec}
        disabled={disabled}
      />
      <Button size="sm" onClick={submit} disabled={disabled || !assetKey} className="w-full">
        <Plus className="mr-1 size-3.5" />
        追加
      </Button>
    </div>
  );
}

export function ProductionControl({
  presets,
  assets,
  onCreatePreset,
  onDeletePreset,
  onShowBanner,
  onHideBanner,
  onShowOverlay,
  onHideOverlay,
  onResolveAssetUrl,
  disabled,
}: ProductionControlProps) {
  const [activeTab, setActiveTab] = useState<EffectKind>("banner");
  const [showAddForm, setShowAddForm] = useState(false);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);

  const filtered = useMemo(
    () => presets.filter((p) => p.config.kind === activeTab),
    [presets, activeTab],
  );
  const hasActive = activePresetId !== null;

  const handleAdd = useCallback(
    (label: string, config: EffectConfig) => {
      onCreatePreset(label, config);
      setShowAddForm(false);
    },
    [onCreatePreset],
  );

  const activatePreset = useCallback(
    async (p: Preset) => {
      setActivePresetId(p.presetId);
      const c = p.config;
      if (c.kind === "banner") {
        onShowBanner({
          text: c.text,
          subtext: c.subtext,
          position: c.position,
          autoHideMs: c.autoHideMs,
        });
      } else if (c.kind === "qr") {
        onShowOverlay({
          kind: "qr",
          url: c.url,
          position: c.position,
          sizePercent: c.sizePercent,
          autoHideMs: c.autoHideMs,
        });
      } else {
        const url = await onResolveAssetUrl(c.assetKey);
        // URL を解決できない (admin 直接接続など) なら壊れた <img src=""> を放送に出さない。
        if (!url) {
          setActivePresetId(null);
          return;
        }
        onShowOverlay({
          kind: c.kind,
          url,
          position: c.position,
          sizePercent: c.sizePercent,
          autoHideMs: c.autoHideMs,
        });
      }
    },
    [onShowBanner, onShowOverlay, onResolveAssetUrl],
  );

  const handleHide = useCallback(() => {
    // 表示中プリセットの種別で判定する。タブ切替後に「非表示」を押しても正しい方を消す。
    const activeKind = presets.find((p) => p.presetId === activePresetId)?.config.kind;
    setActivePresetId(null);
    if ((activeKind ?? activeTab) === "banner") {
      onHideBanner();
    } else {
      onHideOverlay();
    }
  }, [presets, activePresetId, activeTab, onHideBanner, onHideOverlay]);

  return (
    <div className="space-y-3">
      {/* Effect type selector */}
      <div className="flex gap-1 rounded-lg bg-surface-2 p-1">
        {EFFECT_ITEMS.map(({ kind, icon: Icon, label }) => {
          const count = presets.filter((p) => p.config.kind === kind).length;
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
                disabled && "cursor-not-allowed opacity-40",
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
      {filtered.length > 0 && (
        <div className="space-y-1">
          {filtered.map((p) => (
            <div
              key={p.presetId}
              className={cn(
                "group flex items-center gap-2 rounded-md border px-2.5 py-1.5 transition-colors",
                activePresetId === p.presetId
                  ? "border-tally-500/50 bg-tally-500/10"
                  : "border-line-1 bg-surface-1 hover:bg-surface-2",
              )}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text-primary">{presetLabel(p)}</p>
                {presetSubLabel(p) && (
                  <p className="truncate text-xs text-text-tertiary">{presetSubLabel(p)}</p>
                )}
              </div>
              <Button
                size="icon-sm"
                variant={activePresetId === p.presetId ? "default" : "outline"}
                onClick={() => activatePreset(p)}
                disabled={disabled}
                aria-label="表示"
                className="shrink-0"
              >
                <Play className="size-3" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => onDeletePreset(p.presetId)}
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
      {filtered.length === 0 && !showAddForm && (
        <p className="py-2 text-center text-xs text-text-tertiary">プリセットがありません</p>
      )}

      {/* Add form toggle */}
      <button
        type="button"
        onClick={() => setShowAddForm(!showAddForm)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
      >
        {showAddForm ? <ChevronUp className="size-3.5" /> : <Plus className="size-3.5" />}
        {showAddForm ? "閉じる" : "新規追加"}
      </button>

      {/* Per-kind add form */}
      {showAddForm && (
        <div className="rounded-md border border-line-1 bg-surface-2 p-3">
          {activeTab === "banner" && (
            <BannerForm onSubmit={handleAdd} assets={assets} disabled={disabled} />
          )}
          {activeTab === "qr" && (
            <QrForm onSubmit={handleAdd} assets={assets} disabled={disabled} />
          )}
          {activeTab === "image" && (
            <AssetOverlayForm
              kind="image"
              onSubmit={handleAdd}
              assets={assets}
              disabled={disabled}
            />
          )}
          {activeTab === "video" && (
            <AssetOverlayForm
              kind="video"
              onSubmit={handleAdd}
              assets={assets}
              disabled={disabled}
            />
          )}
        </div>
      )}
    </div>
  );
}
