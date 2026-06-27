/**
 * イベント詳細: Setup / Artifacts の 2 タブ構成 (ADR 0014 D-1)。
 *
 * 配信操作 (Layout / Egress / Lifecycle) は stage-web に移管 (ADR 0014 D-2)。
 * admin-web は OpenStageButton で stage-web を開くだけ。
 */
import { useCallback, useEffect, useState } from "react";
import type { AssetMetadata, EventDefinition, EventStatus, InvitedRole } from "@stagecast/shared";
import type {
  Artifact,
  ArtifactService,
  AssetService,
  ControlApiClient,
  IssuedInvite,
} from "../api/types.js";
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
  CardTitle,
  EmptyState,
  Input,
  Label,
  OpenStageButton,
  StatusPill,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@stagecast/ui";
import { Download, ExternalLink, File, Image, Tag, Trash2, Upload, X } from "@stagecast/ui/icons";

const TRANSITIONS: Record<
  EventStatus,
  { label: string; status: EventStatus; variant: "default" | "outline" | "destructive" }[]
> = {
  draft: [
    { label: "予定にする", status: "scheduled", variant: "outline" },
    { label: "配信開始", status: "live", variant: "default" },
  ],
  scheduled: [
    { label: "下書きに戻す", status: "draft", variant: "outline" },
    { label: "配信開始", status: "live", variant: "default" },
  ],
  warmup: [
    { label: "配信開始", status: "live", variant: "default" },
    { label: "下書きに戻す", status: "draft", variant: "outline" },
  ],
  live: [{ label: "配信終了", status: "ended", variant: "destructive" }],
  ended: [],
};

function StatusTransitionBar(props: {
  status: EventStatus;
  busy: boolean;
  onTransition: (next: EventStatus) => void;
}) {
  const actions = TRANSITIONS[props.status];
  if (actions.length === 0) return null;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-line-1 bg-surface-1 px-4 py-2.5">
      <span className="text-xs text-text-secondary">ステータス変更:</span>
      {actions.map((a) => (
        <Button
          key={a.status}
          variant={a.variant}
          size="sm"
          disabled={props.busy}
          onClick={() => props.onTransition(a.status)}
        >
          {a.label}
        </Button>
      ))}
    </div>
  );
}

function AssetManagerTab(props: {
  eventId: string;
  client: ControlApiClient;
  assets: AssetService;
}) {
  const { eventId, client, assets } = props;
  const [assetList, setAssetList] = useState<AssetMetadata[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [tagFilter, setTagFilter] = useState<string | undefined>();
  const [uploadTags, setUploadTags] = useState("");
  const [editingAssetId, setEditingAssetId] = useState<string | undefined>();
  const [editTagsInput, setEditTagsInput] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AssetMetadata | undefined>();

  const allTags = Array.from(new Set(assetList.flatMap((a) => a.tags))).sort();

  const filteredAssets = tagFilter
    ? assetList.filter((a) => a.tags.includes(tagFilter))
    : assetList;

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
      const list = await client.listAssets(eventId);
      setAssetList(list);
      setLoaded(true);
    } catch (err) {
      setError(toErrorMessage(err));
    }
  }, [client, eventId]);

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
        await assets.upload(eventId, { name: file.name, contentType: file.type, bytes }, tags);
      }
      setUploadTags("");
      await loadAssets();
    })();

  const handleUpdateTags = (assetId: string) =>
    guard(async () => {
      const tags = editTagsInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      await client.updateAssetTags(eventId, assetId, tags);
      setEditingAssetId(undefined);
      setEditTagsInput("");
      await loadAssets();
    })();

  const handleDelete = (asset: AssetMetadata) =>
    guard(async () => {
      await client.deleteAsset(eventId, asset.assetId);
      setDeleteTarget(undefined);
      await loadAssets();
    })();

  const iconForType = (contentType: string) => {
    if (contentType.startsWith("image/")) return <Image className="size-4 text-tally-500" />;
    if (contentType.startsWith("video/")) return <File className="size-4 text-amber-500" />;
    return <File className="size-4 text-text-tertiary" />;
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Upload className="size-4" />
            アセットをアップロード
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="asset-tags">タグ (カンマ区切り)</Label>
            <Input
              id="asset-tags"
              placeholder="例: ロゴ, 背景, スポンサー"
              value={uploadTags}
              onChange={(e) => setUploadTags(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="asset-upload">ファイル選択</Label>
            <Input
              id="asset-upload"
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

      {error && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-md border border-error/40 bg-error/10 px-4 py-3 text-sm text-error"
        >
          <span className="flex-1">{error}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="閉じる"
            onClick={() => setError(undefined)}
          >
            ×
          </Button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Tag className="size-4" />
            アセット一覧
            <span className="text-sm font-normal text-text-secondary">
              ({filteredAssets.length}件)
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {allTags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-text-secondary">タグ:</span>
              <button
                type="button"
                onClick={() => setTagFilter(undefined)}
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                  !tagFilter
                    ? "bg-text-primary text-surface-0"
                    : "bg-surface-2 text-text-secondary hover:bg-surface-3"
                }`}
              >
                すべて
              </button>
              {allTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => setTagFilter(tagFilter === tag ? undefined : tag)}
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                    tagFilter === tag
                      ? "bg-tally-500 text-white"
                      : "bg-surface-2 text-text-secondary hover:bg-surface-3"
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}

          {!loaded ? (
            <p className="text-sm text-text-secondary">読み込み中…</p>
          ) : filteredAssets.length === 0 ? (
            <EmptyState
              title="アセットなし"
              description="上のフォームからファイルをアップロードしてください"
              icon={<Upload />}
            />
          ) : (
            <ul className="space-y-2">
              {filteredAssets.map((asset) => (
                <li key={asset.assetId} className="rounded-md border border-line-1 px-3 py-2.5">
                  <div className="flex items-center gap-3">
                    {iconForType(asset.contentType)}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-text-primary">
                        {asset.filename}
                      </p>
                      <p className="text-xs text-text-tertiary">{asset.contentType}</p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="タグを編集"
                        onClick={() => {
                          setEditingAssetId(asset.assetId);
                          setEditTagsInput(asset.tags.join(", "));
                        }}
                      >
                        <Tag className="size-3.5" />
                      </Button>
                      <AlertDialog
                        open={deleteTarget?.assetId === asset.assetId}
                        onOpenChange={(open) => {
                          if (!open) setDeleteTarget(undefined);
                        }}
                      >
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="アセットを削除"
                            onClick={() => setDeleteTarget(asset)}
                            disabled={busy}
                          >
                            <Trash2 className="size-3.5 text-error" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>アセットを削除しますか？</AlertDialogTitle>
                            <AlertDialogDescription>
                              「{asset.filename}」を削除します。S3
                              上のファイルも削除されます。この操作は取り消せません。
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>キャンセル</AlertDialogCancel>
                            <AlertDialogAction
                              className="bg-error text-error-foreground hover:bg-error/90"
                              onClick={() => handleDelete(asset)}
                            >
                              削除する
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>
                  {asset.tags.length > 0 && editingAssetId !== asset.assetId && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {asset.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-text-secondary"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  {editingAssetId === asset.assetId && (
                    <div className="mt-2 flex items-center gap-2">
                      <Input
                        value={editTagsInput}
                        onChange={(e) => setEditTagsInput(e.target.value)}
                        placeholder="タグ (カンマ区切り)"
                        className="h-8 text-xs"
                        disabled={busy}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleUpdateTags(asset.assetId);
                          if (e.key === "Escape") setEditingAssetId(undefined);
                        }}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleUpdateTags(asset.assetId)}
                        disabled={busy}
                      >
                        保存
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setEditingAssetId(undefined)}
                      >
                        <X className="size-3.5" />
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function EventDetail(props: {
  event: EventDefinition;
  client: ControlApiClient;
  assets: AssetService;
  artifacts: ArtifactService;
  onChanged: () => void;
  onDelete: (id: string) => void;
}) {
  const { event, client, assets, artifacts, onChanged } = props;
  const [invites, setInvites] = useState<IssuedInvite[]>([]);
  const [artifactList, setArtifactList] = useState<Artifact[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const guard = (fn: () => Promise<void>) => async () => {
    setError(undefined);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const loadArtifacts = guard(async () => {
    setArtifactList(await artifacts.list(event.id));
  });

  const uploadQr = (file: File) =>
    guard(async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const ref = await assets.upload(event.id, {
        name: file.name,
        contentType: file.type,
        bytes,
      });
      await client.updateEvent(event.id, { qrAsset: ref });
      onChanged();
    })();

  const issue = (role: InvitedRole) =>
    guard(async () => {
      const invite = await client.issueInvite(event.id, role, 60 * 60 * 12);
      setInvites((prev) => [...prev, invite]);
    })();

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-text-primary">{event.title}</h2>
          <StatusPill
            variant={
              event.status === "scheduled"
                ? "scheduled"
                : event.status === "warmup"
                  ? "warmup"
                  : event.status === "live"
                    ? "live"
                    : event.status === "ended"
                      ? "ended"
                      : "draft"
            }
          />
        </div>
        <div className="flex items-center gap-2">
          <OpenStageButton
            eventId={event.id}
            fetcher={(eventId) => client.issueStageToken(eventId)}
            className="gap-2"
          />
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="イベントを削除"
                disabled={busy || event.status === "live"}
                title={event.status === "live" ? "配信中は削除できません" : "イベントを削除"}
              >
                <Trash2 className="size-4 text-error" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>イベントを削除しますか？</AlertDialogTitle>
                <AlertDialogDescription>
                  「{event.title}
                  」と関連するアセット・録画・字幕ファイルがすべて削除されます。この操作は取り消せません。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>キャンセル</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-error text-error-foreground hover:bg-error/90"
                  onClick={() => props.onDelete(event.id)}
                >
                  削除する
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <StatusTransitionBar
        status={event.status}
        busy={busy}
        onTransition={(next) =>
          guard(async () => {
            await client.setStatus(event.id, next);
            onChanged();
          })()
        }
      />

      {error && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-md border border-error/40 bg-error/10 px-4 py-3 text-sm text-error"
        >
          <span className="flex-1">{error}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="閉じる"
            onClick={() => setError(undefined)}
          >
            ×
          </Button>
        </div>
      )}

      <Tabs defaultValue="setup">
        <TabsList>
          <TabsTrigger value="setup">Setup</TabsTrigger>
          <TabsTrigger value="assets">Assets</TabsTrigger>
          <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
        </TabsList>

        <TabsContent value="setup" className="space-y-6 pt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Upload className="size-4" />
                素材
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2">
                <Label htmlFor="qr-upload">QR コード画像</Label>
                <Input
                  id="qr-upload"
                  type="file"
                  accept="image/*"
                  disabled={busy}
                  onChange={(e) => e.target.files?.[0] && uploadQr(e.target.files[0])}
                />
              </div>
              {event.qrAsset && (
                <p className="text-sm text-text-secondary">登録済み QR: {event.qrAsset.key}</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ExternalLink className="size-4" />
                招待 URL
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => issue("moderator")} disabled={busy}>
                  モデレーター招待を発行
                </Button>
                <Button variant="outline" onClick={() => issue("speaker")} disabled={busy}>
                  登壇者招待を発行
                </Button>
              </div>
              {invites.length > 0 && (
                <ul className="space-y-2">
                  {invites.map((inv) => (
                    <li key={inv.jti} className="rounded-md border border-line-1 px-3 py-2 text-sm">
                      <span className="font-medium text-text-primary">{inv.role}</span>
                      <code className="mt-1 block break-all text-xs text-text-secondary">
                        {inv.url}
                      </code>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">イベント情報</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-text-secondary">
              <p>
                ID: <code className="text-xs">{event.id}</code>
              </p>
              {event.startsAt && <p>開催日時: {event.startsAt}</p>}
              {event.caption && <p>字幕エンジン: {event.caption.engine}</p>}
              {event.media?.livekitUrl && (
                <p>
                  LiveKit URL: <code className="text-xs">{event.media.livekitUrl}</code>
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="assets" className="pt-4">
          <AssetManagerTab eventId={event.id} client={client} assets={assets} />
        </TabsContent>

        <TabsContent value="artifacts" className="space-y-6 pt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Download className="size-4" />
                成果物 (録画 / 字幕)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button variant="outline" onClick={loadArtifacts} disabled={busy}>
                一覧を更新
              </Button>
              {artifactList === undefined ? (
                <EmptyState
                  title="成果物を読み込む"
                  description="上のボタンで一覧を取得してください"
                  icon={<Download />}
                />
              ) : artifactList.length === 0 ? (
                <EmptyState
                  title="成果物なし"
                  description="配信終了後に表示されます"
                  icon={<Download />}
                />
              ) : (
                <ul className="space-y-2">
                  {artifactList.map((a) => (
                    <li
                      key={a.key}
                      className="flex items-center gap-3 rounded-md border border-line-1 px-3 py-2 text-sm"
                    >
                      <StatusPill variant={a.kind === "recording" ? "ok" : "muted"} showDot={false}>
                        {a.kind === "recording" ? "録画" : "字幕"}
                      </StatusPill>
                      <a
                        href={a.downloadUrl}
                        download={a.name}
                        rel="noreferrer"
                        className="text-text-primary underline underline-offset-2 hover:text-tally-500"
                      >
                        {a.name}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </section>
  );
}
