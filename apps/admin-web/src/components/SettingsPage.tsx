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
  onRegenerateKeys: () => Promise<void>;
}) {
  const [keyError, setKeyError] = useState<string | undefined>();
  const [keyBusy, setKeyBusy] = useState(false);

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
        全イベント共有の LiveKit API キー / シークレット (ADR 0008 D-5) です。サーバ側で
        ランダム生成して Secrets Manager (<code>stagecast/livekit</code>) に保存します
        (画面に値は表示されません)。URL はイベント単位で reconcile が自動設定するため、
        ここでは扱いません (ADR 0008 D-1)。
      </p>
      {keyError && (
        <p className="error" role="alert">
          {keyError}
        </p>
      )}
      <button type="button" onClick={regenerate} disabled={keyBusy}>
        {keyBusy ? "生成中…" : "鍵を生成 / 再生成"}
      </button>
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
