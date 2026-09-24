/**
 * イベント詳細: Setup / Artifacts の 2 タブ構成 (ADR 0014 D-1)。
 *
 * 配信操作 (Layout / Egress / Lifecycle) は stage-web に移管 (ADR 0014 D-2)。
 * admin-web は OpenStageButton で stage-web を開くだけ。
 */
import { useCallback, useEffect, useState } from "react";
import { isCaptionEnabled } from "@stagecast/shared";
import type {
  AssetMetadata,
  EventDefinition,
  EventProvisioningInfo,
  EventStatus,
  InvitedRole,
  ProvisioningPhase,
} from "@stagecast/shared";
import type {
  Artifact,
  ArtifactService,
  AssetService,
  ControlApiClient,
  IssuedInvite,
} from "../api/types.js";
import { toErrorMessage } from "../lib/errors.js";
import {
  MATERIAL_ACCEPT,
  type MaterialItem,
  type MaterialsService,
} from "../api/materials-service.js";
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
  OpenStageButton,
  StatusPill,
  Alert,
  Badge,
  Chip,
  FormField,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@stagecast/ui";
import {
  Copy,
  Download,
  ExternalLink,
  File,
  Image,
  Server,
  Tag,
  Trash2,
  Upload,
  X,
} from "@stagecast/ui/icons";

/** 起動が動いている最中の再取得間隔。 */
const PROVISIONING_POLL_ACTIVE_MS = 5000;
/** 落ち着いている (準備完了 / スタック未作成 / 失敗待ち) ときの再取得間隔。 */
const PROVISIONING_POLL_IDLE_MS = 30_000;

/**
 * phase ごとの再取得間隔。
 *
 * `ready` でも監視を止めない: タスクが落ちれば reconcile は phase を `starting` に戻すので、
 * ポーリングを打ち切ると「準備完了」の緑表示のまま実態と乖離する。
 * 逆に `none` / `failed` は reconcile の次 tick 待ちなので 5 秒間隔で叩き続ける意味がない。
 */
function provisioningPollMs(phase: ProvisioningPhase): number {
  return phase === "creating" || phase === "starting" || phase === "deleting"
    ? PROVISIONING_POLL_ACTIVE_MS
    : PROVISIONING_POLL_IDLE_MS;
}

const PHASE_LABEL: Record<ProvisioningPhase, string> = {
  none: "未作成",
  creating: "スタック作成中",
  starting: "タスク起動中",
  ready: "準備完了",
  failed: "作成失敗",
  deleting: "破棄中",
};

const PHASE_VARIANT: Record<ProvisioningPhase, "muted" | "loading" | "warmup" | "ok" | "warn"> = {
  none: "muted",
  creating: "loading",
  starting: "warmup",
  ready: "ok",
  failed: "warn",
  deleting: "loading",
};

const PHASE_HINT: Record<ProvisioningPhase, string> = {
  none: "配信予定にすると CloudFormation スタックの作成が始まります。",
  creating: "CloudFormation がスタックを作成しています。",
  starting: "スタックは完成しました。ECS タスクの起動と LiveKit URL の確定を待っています。",
  ready: "メディア層の準備が完了しました。配信を開始できます。",
  failed: "スタックの作成に失敗しました。次の調整ループで作り直されます。",
  deleting: "スタックを破棄しています。",
};

/**
 * メディア層の起動進捗カード (ADR 0023 D-3)。
 *
 * CloudFormation Express モード (ADR 0023 D-1) では CREATE_COMPLETE が「タスクが動いている」
 * ことを意味しないため、スタックの状態と ECS タスクの running 数を分けて出す。
 * 進行中のあいだだけポーリングし、準備完了になったら止める。
 */
function ProvisioningCard(props: {
  client: ControlApiClient;
  eventId: string;
  eventStatus: EventStatus;
  initial?: EventProvisioningInfo;
}) {
  const { client, eventId, eventStatus } = props;
  const [info, setInfo] = useState<EventProvisioningInfo | undefined>(props.initial);

  const phase: ProvisioningPhase = info?.phase ?? "none";
  // draft/ended はスタックを持たないので監視しない。
  const watching = eventStatus !== "draft" && eventStatus !== "ended";
  const pollMs = provisioningPollMs(phase);

  useEffect(() => {
    if (!watching) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const latest = await client.getEvent(eventId);
        if (!cancelled) setInfo(latest.provisioning);
      } catch {
        // 一時的な取得失敗は次の tick で回復する (進捗表示のためだけの読み取り)。
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [watching, pollMs, client, eventId]);

  if (!watching) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Server className="size-4" />
          配信インフラ
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <StatusPill variant={PHASE_VARIANT[phase]}>{PHASE_LABEL[phase]}</StatusPill>
          {info?.stackStatus && (
            <code className="text-xs text-text-secondary">{info.stackStatus}</code>
          )}
        </div>
        <p className="text-sm text-text-secondary">{PHASE_HINT[phase]}</p>

        {/*
          失敗理由を出す (NEXT_WORK D16)。これが無いと reconcile が毎分失敗していても
          「未作成」としか出ず、配信を始められない障害が無言で進行する。
        */}
        {info?.error && (
          <Alert>
            <p className="text-xs font-medium">起動に失敗しています</p>
            <code className="mt-1 block break-words text-xs text-text-secondary">{info.error}</code>
            <p className="mt-2 text-xs text-text-tertiary">
              次の調整ループで自動的に再試行されます。繰り返す場合は設定かデプロイを確認してください。
            </p>
          </Alert>
        )}

        {info && info.services.length > 0 && (
          <ul className="space-y-2">
            {info.services.map((svc) => (
              <li
                key={svc.name}
                className="flex items-center justify-between rounded-md border border-line-1 px-3 py-2 text-sm"
              >
                <code className="text-xs text-text-primary">{svc.name}</code>
                <span className="text-text-secondary">
                  {svc.missing ? "未作成" : `タスク ${svc.runningCount} / ${svc.desiredCount}`}
                </span>
              </li>
            ))}
          </ul>
        )}

        {/*
          ADR 0027: タスクが RUNNING でも配信できるとは限らない。実際に外から叩いた
          結果をタスク数と並べて出す。ここを出さないと「タスクはあるのに誰も入れない」
          状態が管理画面からは正常に見える (2026-09-17 に実際に踏んだ)。
        */}
        {info?.signalingReady === false && (
          <Alert>
            <p className="font-medium">
              シグナリングに到達できません（配信・入室ともにできない状態です）
            </p>
            {info.signalingError && (
              <p className="mt-1 break-all text-xs text-text-secondary">{info.signalingError}</p>
            )}
          </Alert>
        )}

        {info && (
          <p className="text-xs text-text-tertiary">
            LiveKit URL: {info.mediaReady ? "確定済み" : "未確定"} ／ 配信接続:{" "}
            {info.signalingReady === undefined
              ? "未確認"
              : info.signalingReady
                ? "応答あり"
                : "応答なし"}{" "}
            ／ 最終確認 {new Date(info.observedAtMs).toLocaleTimeString()}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

const INVITE_ROLE_LABEL: Record<InvitedRole, string> = {
  moderator: "モデレーター",
  speaker: "登壇者",
};

const TRANSITIONS: Record<
  EventStatus,
  { label: string; status: EventStatus; variant: "live" | "outline" | "destructive" }[]
> = {
  draft: [
    { label: "予定にする", status: "scheduled", variant: "outline" },
    { label: "配信開始", status: "live", variant: "live" },
  ],
  scheduled: [
    { label: "下書きに戻す", status: "draft", variant: "outline" },
    { label: "配信開始", status: "live", variant: "live" },
  ],
  warmup: [
    { label: "配信開始", status: "live", variant: "live" },
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

function AssetManagerTab(props: { client: ControlApiClient; assets: AssetService }) {
  const { client, assets } = props;
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
      await loadAssets();
    })();

  const handleUpdateTags = (assetId: string) =>
    guard(async () => {
      const tags = editTagsInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      await client.updateAsset(assetId, { tags });
      setEditingAssetId(undefined);
      setEditTagsInput("");
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
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Upload className="size-4" />
            アセットをアップロード
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <FormField id="asset-tags" label="タグ (カンマ区切り)">
            <Input
              id="asset-tags"
              placeholder="例: ロゴ, 背景, スポンサー"
              value={uploadTags}
              onChange={(e) => setUploadTags(e.target.value)}
              disabled={busy}
            />
          </FormField>
          <FormField id="asset-upload" label="ファイル選択">
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
          </FormField>
        </CardContent>
      </Card>

      {error && <Alert onDismiss={() => setError(undefined)}>{error}</Alert>}

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
              <Chip selected={!tagFilter} onClick={() => setTagFilter(undefined)}>
                すべて
              </Chip>
              {allTags.map((tag) => (
                <Chip
                  key={tag}
                  selected={tagFilter === tag}
                  onClick={() => setTagFilter(tagFilter === tag ? undefined : tag)}
                >
                  {tag}
                </Chip>
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
                            <AlertDialogAction onClick={() => handleDelete(asset)}>
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
                        <Badge key={tag}>{tag}</Badge>
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
  materials: MaterialsService;
  onChanged: () => void;
  onDelete: (id: string) => void;
  /** このイベントの設定を写した新規作成フォームを開く。 */
  onCopy: (event: EventDefinition) => void;
}) {
  const { event, client, assets, artifacts, materials, onChanged } = props;
  // undefined = 未取得 (読み込み中 or 失敗)。 失敗は inviteError で見せる。
  const [invites, setInvites] = useState<IssuedInvite[] | undefined>();
  const [inviteError, setInviteError] = useState<string | undefined>();
  // コピー直後だけボタンの文言を変える (toast を出すほどの出来事ではない)。
  const [copiedJti, setCopiedJti] = useState<string | undefined>();
  const copyInvite = (inv: IssuedInvite) => {
    navigator.clipboard
      .writeText(inv.url)
      .then(() => {
        setCopiedJti(inv.jti);
        setTimeout(() => setCopiedJti((cur) => (cur === inv.jti ? undefined : cur)), 2000);
      })
      .catch(() => setError("クリップボードに書き込めませんでした"));
  };
  const [artifactList, setArtifactList] = useState<Artifact[] | undefined>();
  // ADR 0021: 翻訳参考資料。登録すると抽出 Lambda がテキストを取り出し、字幕翻訳の文脈になる。
  const [materialList, setMaterialList] = useState<MaterialItem[]>([]);
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

  const loadMaterials = useCallback(() => {
    // 一覧の取得失敗で画面全体を止めない (資料は補助的な機能)。
    materials
      .list(event.id)
      .then(setMaterialList)
      .catch(() => setMaterialList([]));
    // status も見る: 配信終了で資料はサーバ側から消えるので (PR #240)、
    // ここを event.id だけにすると「もう無いファイル」が一覧に残り続ける。
  }, [materials, event.id, event.status]);

  useEffect(loadMaterials, [loadMaterials]);

  const uploadMaterial = (file: File) =>
    guard(async () => {
      await materials.upload(event.id, file);
      loadMaterials();
    })();

  const removeMaterial = (assetId: string) =>
    guard(async () => {
      await materials.remove(event.id, assetId);
      loadMaterials();
    })();

  const loadArtifacts = guard(async () => {
    setArtifactList(await artifacts.list(event.id));
  });

  // タブを開いたら勝手に取りにいく。失敗は画面全体の赤帯にせず未取得のままにして、
  // 「一覧を更新」を押したときだけ guard 経由でエラーを見せる。
  const loadArtifactsOnOpen = () => {
    if (artifactList !== undefined) return;
    artifacts
      .list(event.id)
      .then(setArtifactList)
      .catch(() => {});
  };

  const uploadQr = (file: File) =>
    guard(async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const ref = await assets.upload({
        name: file.name,
        contentType: file.type,
        bytes,
      });
      await client.updateEvent(event.id, { qrAsset: ref });
      onChanged();
    })();

  // 招待 URL はロールごとに 1 本で、サーバーが持つ (ADR 0029)。開いた時点で取りにいく。
  // 終了したイベントの URL は期限切れなので取らない (死んだリンクを生きているように見せない)。
  // endsAt を編集すると期限表示が変わるので日時と status を依存に入れる。 event オブジェクトごと
  // 入れると refresh のたびに再取得してしまう (URL 自体は変わらない)。
  const { id: eventId, status: eventStatus, startsAt, endsAt } = event;
  const loadInvites = useCallback(() => {
    if (eventStatus === "ended") return;
    let cancelled = false;
    setInviteError(undefined);
    client
      .listInvites(eventId)
      .then((list) => {
        if (!cancelled) setInvites(list);
      })
      .catch((err) => {
        if (!cancelled) setInviteError(toErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client, eventId, eventStatus, startsAt, endsAt]);

  useEffect(loadInvites, [loadInvites]);

  const reissue = (jti: string) =>
    guard(async () => {
      const next = await client.reissueInvite(jti);
      setInvites((prev) => prev?.map((inv) => (inv.jti === jti ? next : inv)));
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
            onError={(err) => setError(toErrorMessage(err))}
            className="gap-2"
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="このイベントをコピーして新規作成"
            title="このイベントをコピーして新規作成"
            onClick={() => props.onCopy(event)}
          >
            <Copy className="size-4" />
          </Button>
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
                <AlertDialogAction onClick={() => props.onDelete(event.id)}>
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

      {error && <Alert onDismiss={() => setError(undefined)}>{error}</Alert>}

      <Tabs
        defaultValue="setup"
        onValueChange={(tab) => {
          if (tab === "artifacts") loadArtifactsOnOpen();
        }}
      >
        <TabsList>
          <TabsTrigger value="setup">Setup</TabsTrigger>
          <TabsTrigger value="assets">Assets</TabsTrigger>
          <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
        </TabsList>

        <TabsContent value="setup" className="space-y-6 pt-4">
          <ProvisioningCard
            // イベントを切り替えたときに前のイベントの観測値を引きずらないよう作り直す。
            key={event.id}
            client={client}
            eventId={event.id}
            eventStatus={event.status}
            {...(event.provisioning ? { initial: event.provisioning } : {})}
          />

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Upload className="size-4" />
                素材
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField id="qr-upload" label="QR コード画像">
                <Input
                  id="qr-upload"
                  type="file"
                  accept="image/*"
                  disabled={busy}
                  onChange={(e) => e.target.files?.[0] && uploadQr(e.target.files[0])}
                />
              </FormField>
              {event.qrAsset && (
                <p className="text-sm text-text-secondary">登録済み QR: {event.qrAsset.key}</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <File className="size-4" />
                翻訳参考資料
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-text-secondary">
                登壇資料を登録すると、本文を字幕翻訳の文脈に使って用語の訳を揃えます。
                投影しない発表原稿や話者ノートも登録できます。
              </p>
              <FormField id="material-upload" label="資料 (PDF / PPTX / Markdown / テキスト)">
                <Input
                  id="material-upload"
                  type="file"
                  accept={MATERIAL_ACCEPT}
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void uploadMaterial(file);
                    // 同じファイルを選び直せるように値を消す。
                    e.target.value = "";
                  }}
                />
              </FormField>
              {materialList.length > 0 ? (
                <ul className="space-y-2">
                  {materialList.map((m) => (
                    <li
                      key={m.assetId}
                      className="flex items-center justify-between rounded-md border border-line-1 px-3 py-2 text-sm"
                    >
                      <span className="truncate text-text-primary">{m.filename}</span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy}
                        onClick={() => void removeMaterial(m.assetId)}
                        aria-label={`${m.filename} を削除`}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-text-tertiary">まだ登録されていません。</p>
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
            <CardContent className="space-y-3">
              {event.status === "ended" ? (
                <p className="text-sm text-text-tertiary">
                  終了したイベントの招待 URL は無効です。
                </p>
              ) : inviteError ? (
                <div className="flex items-center gap-3 text-sm text-error">
                  <span className="flex-1">招待 URL を取得できませんでした: {inviteError}</span>
                  <Button variant="outline" size="sm" onClick={loadInvites}>
                    再試行
                  </Button>
                </div>
              ) : invites === undefined ? (
                <p className="text-sm text-text-tertiary">読み込み中…</p>
              ) : (
                <ul className="space-y-2">
                  {invites.map((inv) => (
                    <li
                      key={inv.jti}
                      className="flex items-center gap-3 rounded-md border border-line-1 px-3 py-2 text-sm"
                    >
                      <span className="w-24 shrink-0 font-medium text-text-primary">
                        {INVITE_ROLE_LABEL[inv.role]}
                      </span>
                      {inv.revoked ? (
                        <span className="flex-1 text-xs text-warning">
                          失効中 — 再発行するまで入室できません
                        </span>
                      ) : inv.expiresAtSec * 1000 < Date.now() ? (
                        <span className="flex-1 text-xs text-warning">
                          期限切れ — イベントの日時を更新すると同じ URL が有効になります
                        </span>
                      ) : (
                        <>
                          <code className="min-w-0 flex-1 truncate text-xs text-text-secondary">
                            {inv.url}
                          </code>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => copyInvite(inv)}
                            aria-label={`${INVITE_ROLE_LABEL[inv.role]}の招待 URL をコピー`}
                          >
                            <Copy />
                            {copiedJti === inv.jti ? "コピーしました" : "コピー"}
                          </Button>
                        </>
                      )}
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="sm" disabled={busy}>
                            再発行
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>
                              {INVITE_ROLE_LABEL[inv.role]}の招待 URL を再発行しますか？
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              今の URL は無効になります。すでに共有した相手には新しい URL
                              を送り直してください。
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>キャンセル</AlertDialogCancel>
                            <AlertDialogAction onClick={() => reissue(inv.jti)}>
                              再発行する
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </li>
                  ))}
                </ul>
              )}
              {invites?.[0] && event.status !== "ended" && (
                <p className="text-xs text-text-tertiary">
                  有効期限: {new Date(invites[0].expiresAtSec * 1000).toLocaleString("ja-JP")} まで
                  （イベント終了 + 1 時間。日時を編集すると URL はそのままで期限だけ変わります）
                </p>
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
              {event.caption && (
                <p>
                  字幕:{" "}
                  {isCaptionEnabled(event.caption)
                    ? `オン (${event.caption.engine})`
                    : "オフ (字幕ワーカーを起動しない)"}
                </p>
              )}
              {event.media?.livekitUrl && (
                <p>
                  LiveKit URL: <code className="text-xs">{event.media.livekitUrl}</code>
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="assets" className="pt-4">
          <AssetManagerTab client={client} assets={assets} />
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
                        className="text-text-primary underline underline-offset-2 hover:text-brand-text"
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
