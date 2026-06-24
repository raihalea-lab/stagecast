/**
 * 運用設定ページ: LiveKit / YouTube 認証情報の登録 (ADR D-10, ADR 0008 D-7)。
 *
 * 機密値は GET で読み戻さない (configured フラグのみ表示)。URL は per-event 化 (ADR 0008)
 * により events.media.livekitUrl に保存されるため、本ページでは扱わない。
 */
import { useCallback, useEffect, useState } from "react";
import type {
  LiveKitSettingsStatus,
  YouTubeCredentials,
  YouTubeSettingsStatus,
} from "@stagecast/shared";
import type { ControlApiClient } from "../api/types.js";
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
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  StatusPill,
} from "@stagecast/ui";

interface Props {
  client: ControlApiClient;
}

export function SettingsPage(props: Props) {
  const { client } = props;
  const [livekitStatus, setLivekitStatus] = useState<LiveKitSettingsStatus | undefined>();
  const [youtubeStatus, setYoutubeStatus] = useState<YouTubeSettingsStatus | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();

  const reload = useCallback(async () => {
    setLoadError(undefined);
    try {
      const [lk, yt] = await Promise.all([
        client.getLiveKitSettings(),
        client.getYouTubeSettings(),
      ]);
      setLivekitStatus(lk);
      setYoutubeStatus(yt);
    } catch (err) {
      setLoadError(toErrorMessage(err));
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">運用設定</h2>
        <p className="mt-1 text-sm text-text-secondary">
          LiveKit / YouTube 連携の認証情報を登録します。値はサーバーに送信した時点で Secrets Manager
          に保存され、画面に読み戻すことはありません。
        </p>
      </div>
      {loadError && (
        <div
          role="alert"
          className="rounded-md border border-error/40 bg-error/10 px-4 py-3 text-sm text-error"
        >
          設定の取得に失敗しました: {loadError}
        </div>
      )}
      <LiveKitForm
        status={livekitStatus}
        onRegenerateKeys={async () => {
          const next = await client.regenerateLiveKitKeys();
          setLivekitStatus(next);
        }}
      />
      <YouTubeForm
        status={youtubeStatus}
        onSave={async (creds) => {
          const next = await client.putYouTubeSettings(creds);
          setYoutubeStatus(next);
        }}
      />
    </section>
  );
}

function configuredVariant(configured: boolean | undefined) {
  if (configured === undefined) return "loading" as const;
  return configured ? ("ok" as const) : ("warn" as const);
}

function LiveKitForm(props: {
  status: LiveKitSettingsStatus | undefined;
  onRegenerateKeys: () => Promise<void>;
}) {
  const [keyError, setKeyError] = useState<string | undefined>();
  const [keyBusy, setKeyBusy] = useState(false);

  const regenerate = async () => {
    setKeyError(undefined);
    setKeyBusy(true);
    try {
      await props.onRegenerateKeys();
    } catch (err) {
      setKeyError(toErrorMessage(err));
    } finally {
      setKeyBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <CardTitle>LiveKit</CardTitle>
          <StatusPill variant={configuredVariant(props.status?.configured)} />
        </div>
        <CardDescription>
          全イベント共有の LiveKit API キー / シークレットです。サーバ側で ランダム生成して Secrets
          Manager に保存します。 URL はイベント単位で自動設定されます。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {keyError && (
          <div
            role="alert"
            className="rounded-md border border-error/40 bg-error/10 px-3 py-2 text-sm text-error"
          >
            {keyError}
          </div>
        )}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" disabled={keyBusy}>
              {keyBusy ? "生成中…" : "鍵を生成 / 再生成"}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>API キーを再生成しますか？</AlertDialogTitle>
              <AlertDialogDescription>
                既存の鍵で発行された LiveKit トークン（登壇者の入室リンク等）はすべて無効になり、
                LiveKit Server を再起動して新しい値を読み込ませる必要があります。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>キャンセル</AlertDialogCancel>
              <AlertDialogAction onClick={regenerate}>再生成する</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

function YouTubeForm(props: {
  status: YouTubeSettingsStatus | undefined;
  onSave: (creds: YouTubeCredentials) => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState("");
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [streamKey, setStreamKey] = useState("");
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(undefined);
    const patch: YouTubeCredentials = {};
    if (apiKey.trim()) patch.apiKey = apiKey.trim();
    if (oauthClientId.trim()) patch.oauthClientId = oauthClientId.trim();
    if (oauthClientSecret.trim()) patch.oauthClientSecret = oauthClientSecret.trim();
    if (streamKey.trim()) patch.streamKey = streamKey.trim();
    if (Object.keys(patch).length === 0) {
      setSubmitError("更新したい項目を 1 つ以上入力してください。");
      return;
    }
    setBusy(true);
    try {
      await props.onSave(patch);
      setApiKey("");
      setOauthClientId("");
      setOauthClientSecret("");
      setStreamKey("");
    } catch (err) {
      setSubmitError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <CardTitle>YouTube</CardTitle>
          <StatusPill variant={configuredVariant(props.status?.configured)} />
        </div>
        <CardDescription>
          ストリームキー: {props.status?.streamKeyConfigured ? "設定済み" : "未設定"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="yt-api-key">Data API Key</Label>
            <Input
              id="yt-api-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={props.status?.configured ? "再入力する場合のみ" : ""}
              autoComplete="off"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="yt-client-id">OAuth Client ID</Label>
            <Input
              id="yt-client-id"
              value={oauthClientId}
              onChange={(e) => setOauthClientId(e.target.value)}
              placeholder={props.status?.configured ? "再入力する場合のみ" : ""}
              autoComplete="off"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="yt-client-secret">OAuth Client Secret</Label>
            <Input
              id="yt-client-secret"
              type="password"
              value={oauthClientSecret}
              onChange={(e) => setOauthClientSecret(e.target.value)}
              placeholder={props.status?.configured ? "再入力する場合のみ" : ""}
              autoComplete="off"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="yt-stream-key">Stream Key</Label>
            <Input
              id="yt-stream-key"
              type="password"
              value={streamKey}
              onChange={(e) => setStreamKey(e.target.value)}
              placeholder={
                props.status?.streamKeyConfigured ? "再入力する場合のみ" : "YouTube Studio で取得"
              }
              autoComplete="off"
            />
          </div>
          {submitError && (
            <div
              role="alert"
              className="rounded-md border border-error/40 bg-error/10 px-3 py-2 text-sm text-error"
            >
              {submitError}
            </div>
          )}
          <Button type="submit" disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
