/**
 * 管理コンソールのルート (DESIGN.md 3.1, 8 章, F-12)。
 *
 * Cognito Hosted UI (Authorization Code + PKCE) でログインしてから制御 API を呼ぶ。
 * VITE_COGNITO_* が未設定なら認証スキップ (ローカル開発で sessionStorage に直接トークンを
 * 入れて使える)。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { EventDefinition } from "@stagecast/shared";
import type { CreateEventInput } from "@stagecast/control-api";
import { HttpControlApiClient } from "./api/http-client.js";
import { HttpAssetService } from "./api/http-asset-service.js";
import { HttpArtifactService } from "./api/http-artifact-service.js";
import type { ControlApiClient, AssetService, ArtifactService } from "./api/types.js";
import { EventForm } from "./components/EventForm.js";
import { EventDetail } from "./components/EventDetail.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { CognitoAuthClient, cognitoConfig } from "./auth/cognito.js";
import type { RuntimeConfig } from "./config.js";
import { toErrorMessage } from "./lib/errors.js";

interface AuthState {
  status: "loading" | "anonymous" | "authenticated";
  error?: string;
}

export function App(props: {
  /** ランタイム設定 (main.tsx が config.json から解決して渡す)。未指定はテスト/認証なし。 */
  config?: RuntimeConfig;
  client?: ControlApiClient;
  assets?: AssetService;
  artifacts?: ArtifactService;
}) {
  const apiBaseUrl = props.config?.controlApiUrl ?? "";
  // Cognito 設定があれば認証クライアントを構築 (未設定なら認証スキップ＝ローカル/テスト)。
  const cognito = props.config?.cognito;
  const authClient = useMemo(
    () => (cognito ? new CognitoAuthClient(cognitoConfig(cognito)) : undefined),
    [cognito],
  );
  const getIdToken = useCallback(
    (): string | undefined =>
      authClient?.getTokens()?.idToken ?? sessionStorage.getItem("stagecast.idToken") ?? undefined,
    [authClient],
  );

  const client = useMemo(
    () => props.client ?? new HttpControlApiClient(apiBaseUrl, getIdToken),
    [props.client, apiBaseUrl, getIdToken],
  );
  const assets = useMemo(
    () => props.assets ?? new HttpAssetService(apiBaseUrl, getIdToken),
    [props.assets, apiBaseUrl, getIdToken],
  );
  const artifacts = useMemo(
    () => props.artifacts ?? new HttpArtifactService(apiBaseUrl, getIdToken),
    [props.artifacts, apiBaseUrl, getIdToken],
  );

  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [events, setEvents] = useState<EventDefinition[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [apiError, setApiError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  /** 画面切り替え: イベント管理 / 運用設定 (LiveKit / YouTube 認証情報)。 */
  const [view, setView] = useState<"events" | "settings">("events");

  // API 操作を共通ラップ: 実行中は busy、失敗はエラーバナーに出す (従来は握り潰し)。
  const run = useCallback(async (fn: () => Promise<void>) => {
    setApiError(undefined);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setApiError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  // OAuth callback 処理 → 既存トークンの再利用 → ログイン判定。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // 認証無効モード (テスト等) は素通し。
        if (!authClient) {
          if (!cancelled) setAuth({ status: "authenticated" });
          return;
        }
        // /auth/callback?code=...&state=... の処理。
        const url = new URL(window.location.href);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (code && state) {
          await authClient.exchangeCode(code, state);
          // クエリを消して "/" に戻す。
          window.history.replaceState({}, "", "/");
          if (!cancelled) setAuth({ status: "authenticated" });
          return;
        }
        // セッション内に有効トークンがあればそれを使う。
        if (authClient.getTokens()) {
          if (!cancelled) setAuth({ status: "authenticated" });
          return;
        }
        if (!cancelled) setAuth({ status: "anonymous" });
      } catch (err) {
        if (!cancelled) setAuth({ status: "anonymous", error: String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authClient]);

  const refresh = useCallback(async () => {
    const list = await client.listEvents();
    setEvents(list);
  }, [client]);

  useEffect(() => {
    if (auth.status === "authenticated") void run(refresh);
  }, [auth.status, refresh, run]);

  const create = (input: CreateEventInput) =>
    run(async () => {
      const created = await client.createEvent(input);
      await refresh();
      setSelectedId(created.id);
    });

  const login = async () => {
    if (!authClient) return;
    window.location.assign(await authClient.buildLoginUrl());
  };
  const logout = () => {
    if (!authClient) return;
    authClient.clearTokens();
    window.location.assign(authClient.buildLogoutUrl());
  };

  if (auth.status === "loading") {
    return (
      <main className="app">
        <p>読み込み中...</p>
      </main>
    );
  }

  if (auth.status === "anonymous") {
    return (
      <main className="app">
        <header>
          <h1>Stagecast 管理コンソール</h1>
        </header>
        <p>ログインが必要です。</p>
        {auth.error && <pre className="error">{auth.error}</pre>}
        <button onClick={login}>Cognito でログイン</button>
      </main>
    );
  }

  const selected = events.find((e) => e.id === selectedId);

  return (
    <main className="app">
      <header>
        <h1>Stagecast 管理コンソール</h1>
        <nav className="view-nav">
          <button
            onClick={() => setView("events")}
            className={view === "events" ? "active" : ""}
          >
            イベント
          </button>
          <button
            onClick={() => setView("settings")}
            className={view === "settings" ? "active" : ""}
          >
            運用設定
          </button>
        </nav>
        {busy && <span className="busy">処理中…</span>}
        {authClient && <button onClick={logout}>ログアウト</button>}
      </header>
      {apiError && (
        <p className="error" role="alert">
          {apiError} <button onClick={() => setApiError(undefined)}>×</button>
        </p>
      )}
      {view === "settings" ? (
        <SettingsPage client={client} />
      ) : (
        <div className="layout">
          <aside>
            <EventForm onCreate={create} busy={busy} />
            <h2>イベント一覧</h2>
            <ul className="event-list">
              {events.map((e) => (
                <li key={e.id}>
                  <button
                    onClick={() => setSelectedId(e.id)}
                    className={e.id === selectedId ? "active" : ""}
                  >
                    {e.title} ({e.status})
                  </button>
                </li>
              ))}
            </ul>
          </aside>
          <article>
            {selected ? (
              <EventDetail
                event={selected}
                client={client}
                assets={assets}
                artifacts={artifacts}
                onChanged={() => void run(refresh)}
              />
            ) : (
              <p>イベントを選択してください。</p>
            )}
          </article>
        </div>
      )}
    </main>
  );
}
