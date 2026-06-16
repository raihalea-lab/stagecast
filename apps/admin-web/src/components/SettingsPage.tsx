/**
 * 運用設定ページ: LiveKit / YouTube 認証情報の登録 (ADR D-10)。
 *
 * 機密値は GET で読み戻さない (configured フラグと LiveKit URL のみ表示)。PUT は全フィールド
 * 必須の完全置き換えで、運用者が値を入れ直すか「変更しない」かを明示する。
 */
import { useCallback, useEffect, useState } from "react";
import type {
  LiveKitCredentials,
  LiveKitSettingsStatus,
  YouTubeCredentials,
  YouTubeSettingsStatus,
} from "@stagecast/shared";
import type { ControlApiClient } from "../api/types.js";
import { toErrorMessage } from "../lib/errors.js";

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
    <section className="settings">
      <h2>運用設定</h2>
      <p className="settings-note">
        LiveKit / YouTube 連携の認証情報を登録します。値はサーバーに送信した時点で Secrets
        Manager に保存され、画面に読み戻すことはありません (流出防止)。
      </p>
      {loadError && (
        <p className="error" role="alert">
          設定の取得に失敗しました: {loadError}
        </p>
      )}
      <LiveKitForm
        status={livekitStatus}
        onSave={async (creds) => {
          const next = await client.putLiveKitSettings(creds);
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

function StatusBadge(props: { configured: boolean | undefined }) {
  if (props.configured === undefined) return <span className="badge badge-loading">確認中…</span>;
  return props.configured ? (
    <span className="badge badge-ok">設定済み</span>
  ) : (
    <span className="badge badge-warn">未設定</span>
  );
}

function LiveKitForm(props: {
  status: LiveKitSettingsStatus | undefined;
  onSave: (creds: LiveKitCredentials) => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  // 既に設定済みなら、URL だけはサーバーから返ってきた値で初期化する (機密ではないので)。
  useEffect(() => {
    if (props.status?.configured && props.status.url) setUrl(props.status.url);
  }, [props.status]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(undefined);
    if (!url.trim() || !apiKey.trim() || !apiSecret.trim()) {
      setSubmitError("すべての項目を入力してください。");
      return;
    }
    setBusy(true);
    try {
      await props.onSave({ url: url.trim(), apiKey: apiKey.trim(), apiSecret: apiSecret.trim() });
      setApiKey("");
      setApiSecret("");
    } catch (err) {
      setSubmitError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="settings-form">
      <h3>
        LiveKit <StatusBadge configured={props.status?.configured} />
      </h3>
      <label>
        URL (wss://)
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="wss://livekit.example.com"
          autoComplete="off"
        />
      </label>
      <label>
        API Key
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={props.status?.configured ? "再入力する場合のみ" : ""}
          autoComplete="off"
        />
      </label>
      <label>
        API Secret
        <input
          type="password"
          value={apiSecret}
          onChange={(e) => setApiSecret(e.target.value)}
          placeholder={props.status?.configured ? "再入力する場合のみ" : ""}
          autoComplete="off"
        />
      </label>
      {submitError && (
        <p className="error" role="alert">
          {submitError}
        </p>
      )}
      <button type="submit" disabled={busy}>
        {busy ? "保存中…" : "保存"}
      </button>
    </form>
  );
}

function YouTubeForm(props: {
  status: YouTubeSettingsStatus | undefined;
  onSave: (creds: YouTubeCredentials) => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState("");
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(undefined);
    if (!apiKey.trim() || !oauthClientId.trim() || !oauthClientSecret.trim()) {
      setSubmitError("すべての項目を入力してください。");
      return;
    }
    setBusy(true);
    try {
      await props.onSave({
        apiKey: apiKey.trim(),
        oauthClientId: oauthClientId.trim(),
        oauthClientSecret: oauthClientSecret.trim(),
      });
      setApiKey("");
      setOauthClientId("");
      setOauthClientSecret("");
    } catch (err) {
      setSubmitError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="settings-form">
      <h3>
        YouTube <StatusBadge configured={props.status?.configured} />
      </h3>
      <label>
        Data API Key
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={props.status?.configured ? "再入力する場合のみ" : ""}
          autoComplete="off"
        />
      </label>
      <label>
        OAuth Client ID
        <input
          type="text"
          value={oauthClientId}
          onChange={(e) => setOauthClientId(e.target.value)}
          autoComplete="off"
        />
      </label>
      <label>
        OAuth Client Secret
        <input
          type="password"
          value={oauthClientSecret}
          onChange={(e) => setOauthClientSecret(e.target.value)}
          placeholder={props.status?.configured ? "再入力する場合のみ" : ""}
          autoComplete="off"
        />
      </label>
      {submitError && (
        <p className="error" role="alert">
          {submitError}
        </p>
      )}
      <button type="submit" disabled={busy}>
        {busy ? "保存中…" : "保存"}
      </button>
    </form>
  );
}
