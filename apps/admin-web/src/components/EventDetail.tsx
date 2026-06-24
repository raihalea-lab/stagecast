/**
 * イベント詳細: Setup / Artifacts の 2 タブ構成 (ADR 0014 D-1)。
 *
 * 配信操作 (Layout / Egress / Lifecycle) は stage-web に移管 (ADR 0014 D-2)。
 * admin-web は OpenStageButton で stage-web を開くだけ。
 */
import { useState } from "react";
import type { EventDefinition, InvitedRole } from "@stagecast/shared";
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
import { Download, ExternalLink, Trash2, Upload } from "@stagecast/ui/icons";

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
              event.status === "live" ? "live" : event.status === "ended" ? "ended" : "draft"
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
