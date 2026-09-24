import { useCallback, useEffect, useState } from "react";
import type { AssetMetadata } from "@stagecast/shared";
import type { AssetService, ControlApiClient } from "../api/types.js";
import { toErrorMessage } from "../lib/errors.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  Card,
  CardContent,
  CardHeader,
  Alert,
  CardTitle,
  EmptyState,
  Input,
  Label,
} from "@stagecast/ui";
import { File, Image, Search, Tag, Trash2, Upload } from "@stagecast/ui/icons";

export function AssetLibrary(props: { client: ControlApiClient; assets: AssetService }) {
  const { client, assets } = props;
  const [assetList, setAssetList] = useState<AssetMetadata[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [tagFilter, setTagFilter] = useState<string | undefined>();
  const [searchQuery, setSearchQuery] = useState("");
  const [uploadTags, setUploadTags] = useState("");
  const [uploadDescription, setUploadDescription] = useState("");
  const [editingAssetId, setEditingAssetId] = useState<string | undefined>();
  const [editTagsInput, setEditTagsInput] = useState("");
  const [editDescInput, setEditDescInput] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AssetMetadata | undefined>();

  const allTags = Array.from(new Set(assetList.flatMap((a) => a.tags))).sort();

  const filteredAssets = assetList.filter((a) => {
    if (tagFilter && !a.tags.includes(tagFilter)) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      if (
        !a.filename.toLowerCase().includes(q) &&
        !(a.description?.toLowerCase().includes(q) ?? false)
      )
        return false;
    }
    return true;
  });

  const guard = useCallback(
    (fn: () => Promise<void>) => async () => {
      setError(undefined);
      setBusy(true);
      try {
        await fn();
      } catch (err) {
        setError(toErrorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const loadAssets = useCallback(async () => {
    try {
      const list = await client.listAssets();
      setAssetList(list);
      setLoaded(true);
    } catch (err) {
      setError(toErrorMessage(err));
    }
  }, [client]);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  const handleUpload = (files: FileList) =>
    guard(async () => {
      const tags = uploadTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await assets.upload({ name: file.name, contentType: file.type, bytes }, tags);
      }
      setUploadTags("");
      setUploadDescription("");
      await loadAssets();
    })();

  const handleUpdateAsset = (assetId: string) =>
    guard(async () => {
      const tags = editTagsInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      await client.updateAsset(assetId, { tags, description: editDescInput || undefined });
      setEditingAssetId(undefined);
      setEditTagsInput("");
      setEditDescInput("");
      await loadAssets();
    })();

  const handleDelete = (asset: AssetMetadata) =>
    guard(async () => {
      await client.deleteAsset(asset.assetId);
      setDeleteTarget(undefined);
      await loadAssets();
    })();

  const iconForType = (contentType: string) => {
    if (contentType.startsWith("image/")) return <Image className="size-4 text-brand-text" />;
    if (contentType.startsWith("video/")) return <File className="size-4 text-warning" />;
    return <File className="size-4 text-text-tertiary" />;
  };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">アセットライブラリ</h1>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Upload className="size-4" />
            アセットをアップロード
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="lib-asset-tags">タグ (カンマ区切り)</Label>
            <Input
              id="lib-asset-tags"
              placeholder="例: ロゴ, 背景, スポンサー"
              value={uploadTags}
              onChange={(e) => setUploadTags(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="lib-asset-desc">説明 (任意)</Label>
            <Input
              id="lib-asset-desc"
              placeholder="例: 2026年夏イベント用ロゴ"
              value={uploadDescription}
              onChange={(e) => setUploadDescription(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="lib-asset-upload">ファイル選択</Label>
            <Input
              id="lib-asset-upload"
              type="file"
              accept="image/*,video/*"
              multiple
              disabled={busy}
              onChange={(e) =>
                e.target.files && e.target.files.length > 0 && handleUpload(e.target.files)
              }
            />
          </div>
        </CardContent>
      </Card>

      {error && <Alert onDismiss={() => setError(undefined)}>{error}</Alert>}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Tag className="size-4" />
            ライブラリ
            <span className="text-sm font-normal text-text-secondary">
              ({filteredAssets.length}件)
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 size-4 text-text-tertiary" />
              <Input
                placeholder="ファイル名・説明で検索..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>

          {allTags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-text-secondary">タグ:</span>
              <button
                type="button"
                onClick={() => setTagFilter(undefined)}
                className={`rounded-full px-2 py-0.5 text-xs font-medium transition-colors ${
                  !tagFilter
                    ? "bg-brand-600 text-white"
                    : "bg-surface-2 text-text-secondary hover:bg-surface-3"
                }`}
              >
                すべて
              </button>
              {allTags.map((tag) => (
                <button
                  type="button"
                  key={tag}
                  onClick={() => setTagFilter(tagFilter === tag ? undefined : tag)}
                  className={`rounded-full px-2 py-0.5 text-xs font-medium transition-colors ${
                    tagFilter === tag
                      ? "bg-brand-600 text-white"
                      : "bg-surface-2 text-text-secondary hover:bg-surface-3"
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}

          {!loaded ? (
            <p className="text-sm text-text-secondary">読み込み中...</p>
          ) : filteredAssets.length === 0 ? (
            <EmptyState
              title="アセットがありません"
              description="上のフォームからファイルをアップロードしてください"
            />
          ) : (
            <ul className="divide-y divide-line-1">
              {filteredAssets.map((asset) => (
                <li
                  key={asset.assetId}
                  className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
                >
                  {iconForType(asset.contentType)}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{asset.filename}</p>
                    {asset.description && (
                      <p className="truncate text-xs text-text-secondary">{asset.description}</p>
                    )}
                    {editingAssetId === asset.assetId ? (
                      <div className="mt-1.5 flex flex-col gap-1.5">
                        <Input
                          value={editTagsInput}
                          onChange={(e) => setEditTagsInput(e.target.value)}
                          placeholder="タグ (カンマ区切り)"
                          className="h-7 text-xs"
                        />
                        <Input
                          value={editDescInput}
                          onChange={(e) => setEditDescInput(e.target.value)}
                          placeholder="説明"
                          className="h-7 text-xs"
                        />
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() => handleUpdateAsset(asset.assetId)}
                          >
                            保存
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditingAssetId(undefined)}
                          >
                            キャンセル
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-0.5 flex flex-wrap items-center gap-1">
                        {asset.tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-secondary"
                          >
                            {tag}
                          </span>
                        ))}
                        <button
                          type="button"
                          onClick={() => {
                            setEditingAssetId(asset.assetId);
                            setEditTagsInput(asset.tags.join(", "));
                            setEditDescInput(asset.description ?? "");
                          }}
                          className="ml-1 text-[10px] text-text-tertiary hover:text-brand-text"
                        >
                          編集
                        </button>
                      </div>
                    )}
                  </div>
                  <AlertDialog
                    open={deleteTarget?.assetId === asset.assetId}
                    onOpenChange={(open) => !open && setDeleteTarget(undefined)}
                  >
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="削除"
                        disabled={busy}
                        onClick={() => setDeleteTarget(asset)}
                      >
                        <Trash2 className="size-3.5 text-text-tertiary hover:text-error" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>アセットを削除しますか？</AlertDialogTitle>
                        <AlertDialogDescription>
                          「{asset.filename}」を削除します。この操作は取り消せません。
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>キャンセル</AlertDialogCancel>
                        <AlertDialogAction
                          className="bg-error text-white hover:bg-error/90"
                          onClick={() => handleDelete(asset)}
                        >
                          削除
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
