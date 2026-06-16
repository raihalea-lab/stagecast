/**
 * 運用設定ページ: LiveKit / YouTube 認証情報の登録 (ADR D-10)。
 *
 * 機密値は GET で読み戻さない (configured フラグと LiveKit URL のみ表示)。PUT は全フィールド
 * 必須の完全置き換えで、運用者が値を入れ直すか「変更しない」かを明示する。
 */
import { useCallback, useEffect, useState } from "react";
import type {
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
        onSaveUrl={async (url) => {
          const next = await client.patchLiveKitUrl(url);
          setLivekitStatus(next);
        }}
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
  onSaveUrl: (url: string) => Promise<void>;
  onRegenerateKeys: () => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | undefined>();
  const [keyError, setKeyError] = useState<string | undefined>();
  const [urlBusy, setUrlBusy] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  // 機密 (apiKey/apiSecret) はサーバ側 (`POST /settings/livekit/regenerate`) で
  // ランダム生成し Secrets Manager に保存する。UI に値は表示しない (流出防止)。

  // 既存の URL がサーバから返っていればフォームを初期化する。
  useEffect(() => {
    if (props.status?.url) setUrl(props.status.url);
  }, [props.status]);

  const saveUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    setUrlError(undefined);
    if (!url.trim()) {
      setUrlError("URL を入力してください。");
      return;
    }
    setUrlBusy(true);
    try {
      await props.onSaveUrl(url.trim());
    } catch (err) {
      setUrlError(toErrorMessage(err));
    } finally {
      setUrlBusy(false);
    }
  };

  const regenerate = async () => {
    setKeyError(undefined);
    const ok = window.confirm(
      "新しい API キー/シークレットを生成します。\n\n既存の鍵で発行された LiveKit トークン (登壇者の入室リンク等) はすべて無効になり、LiveKit Server を再起動して新しい値を読み込ませる必要があります。\n\n続けますか？",
    );
    if (!ok) return;
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
    <section className="settings-form">
      <h3>
        LiveKit <StatusBadge configured={props.status?.configured} />
      </h3>
      <p className="settings-sub-note">
        self-hosted の LiveKit Server (EventMediaStack の NLB) に接続する設定です。
        URL は NLB DNS、API キー/シークレットはサーバ側で安全にランダム生成して Secrets
        Manager に保存します (画面に値は表示されません)。
      </p>

      <form onSubmit={saveUrl} className="settings-subform">
        <h4>① URL (NLB DNS)</h4>
        <label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="wss://lk-nlb-xxx.elb.ap-northeast-1.amazonaws.com:7880"
            autoComplete="off"
          />
        </label>
        {urlError && (
          <p className="error" role="alert">
            {urlError}
          </p>
        )}
        <button type="submit" disabled={urlBusy}>
          {urlBusy ? "保存中…" : "URL を保存"}
        </button>
      </form>

      <div className="settings-subform">
        <h4>② API キー / シークレット (サーバ生成)</h4>
        <p className="settings-sub-note">
          ボタンを押すとサーバ側で `crypto.randomBytes` でランダム生成し、Secrets Manager
          (`stagecast/livekit`) に保存します。LiveKit Server は ECS Secret 経由でこの値を
          読み込むため、ローカルで Docker を実行する必要はありません。
        </p>
        {keyError && (
          <p className="error" role="alert">
            {keyError}
          </p>
        )}
        <button type="button" onClick={regenerate} disabled={keyBusy}>
          {keyBusy ? "生成中…" : "鍵を生成 / 再生成"}
        </button>
      </div>
    </section>
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
