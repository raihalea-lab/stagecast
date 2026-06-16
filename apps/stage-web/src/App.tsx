/**
 * 登壇者・モデレーター用ステージ画面 (DESIGN.md 4.1, 5.2, F-1, F-3)。
 * 招待 URL のトークンで入室し、登壇者は映像音声・画面共有・スライド送りを操作する。
 */
import { useEffect, useMemo, useState } from "react";
import { HttpStageClient, type StageClient } from "./api/stage-client.js";
import { LiveKitRoomConnector } from "./lib/livekit-room.js";
import { BrowserMediaDevicesProvider } from "./lib/browser-devices.js";
import type { MediaDevicesProvider, PreferredDevices } from "./lib/devices.js";
import type { RoomConnector } from "./lib/room.js";
import { StageController, type StageSession } from "./stage-controller.js";
import { parseInviteToken } from "./lib/token.js";
import { DeviceCheck } from "./components/DeviceCheck.js";
import type { RuntimeConfig } from "./config.js";

export function App(props: {
  /** ランタイム設定 (main.tsx が config.json から解決して渡す)。未指定はテスト/ローカル。 */
  config?: RuntimeConfig;
  client?: StageClient;
  room?: RoomConnector;
  search?: string;
  devices?: MediaDevicesProvider;
}) {
  const controller = useMemo(
    () =>
      new StageController(
        props.client ?? new HttpStageClient(props.config?.controlApiUrl ?? ""),
        props.room ?? new LiveKitRoomConnector(),
      ),
    [props.client, props.room, props.config],
  );
  const deviceProvider = useMemo(
    () => props.devices ?? new BrowserMediaDevicesProvider(),
    [props.devices],
  );
  const initialToken = parseInviteToken(props.search ?? window.location.search) ?? "";

  const [token, setToken] = useState(initialToken);
  const [name, setName] = useState("");
  const [session, setSession] = useState<StageSession | undefined>();
  const [error, setError] = useState<string>();
  const [prefs, setPrefs] = useState<PreferredDevices>({});
  const [mic, setMic] = useState(false);
  const [camera, setCamera] = useState(false);
  const [screen, setScreen] = useState(false);
  const [page, setPage] = useState(1);
  const [reconnecting, setReconnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  /** /join 503 リトライ中の進捗 (ADR 0008 D-3, undefined ならリトライ無し)。 */
  const [retryInfo, setRetryInfo] = useState<
    { attempt: number; nextWaitSec: number; elapsedSec: number } | undefined
  >();

  // SFU 切断を検知したら入室画面へ戻し、再入室を促す。
  // 一時的な回線断は自動再接続を試みるのでセッションは保ち、再接続中バナーだけ出す。
  useEffect(() => {
    controller.onDisconnected(() => {
      setSession(undefined);
      setReconnecting(false);
      setError("配信サーバから切断されました。もう一度入室してください。");
    });
    controller.onReconnecting(() => setReconnecting(true));
    controller.onReconnected(() => setReconnecting(false));
  }, [controller]);

  const join = async () => {
    setError(undefined);
    setRetryInfo(undefined);
    setBusy(true);
    try {
      // 入室前テストで選んだマイク/カメラを publish に反映する (N7)。
      controller.setPreferredDevices(prefs);
      const res = await controller.join(token, name || undefined, {
        // ADR 0008 D-3: EventMediaStack 起動中なら /join が 503。最大 60s リトライ。
        maxRetryWaitSec: 60,
        onRetry: setRetryInfo,
      });
      if (!res.ok) {
        const reason =
          res.reason === "media-unavailable"
            ? "配信サーバの準備が間に合いませんでした。少し待ってからもう一度お試しください。"
            : res.reason;
        setError(`入室できません: ${reason}`);
        return;
      }
      setSession(controller.currentSession);
    } finally {
      setBusy(false);
      setRetryInfo(undefined);
    }
  };

  // 操作中は busy で連打を防ぐ (mic/camera/screen/slide/leave を一括で disabled に)。
  const wrap = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!session) {
    return (
      <main className="join">
        <h1>Stagecast ステージ入室</h1>
        {error && <p className="error">{error}</p>}
        {retryInfo && (
          <p className="retry-progress" role="status">
            配信準備中… ({retryInfo.elapsedSec + retryInfo.nextWaitSec}/60 秒)
            <br />
            <small>
              配信サーバを起動しています。あと {retryInfo.nextWaitSec} 秒で再試行します。
            </small>
          </p>
        )}
        <label>
          招待トークン
          <input value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
        <label>
          表示名
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <DeviceCheck provider={deviceProvider} onChange={setPrefs} />
        <button onClick={join} disabled={!token || busy}>
          {busy ? (retryInfo ? "配信準備待ち…" : "入室中…") : "入室する"}
        </button>
      </main>
    );
  }

  return (
    <main className="stage">
      <h1>
        {session.role === "speaker" ? "登壇者" : "モデレーター"} / イベント {session.eventId}
      </h1>
      {reconnecting && (
        <p className="reconnecting" role="status">
          配信サーバへ再接続中… そのままお待ちください。
        </p>
      )}
      {error && <p className="error">{error}</p>}

      {session.canPublish ? (
        <section className="controls">
          <button
            disabled={busy}
            onClick={wrap(async () => {
              await controller.toggleMic(!mic);
              setMic(!mic);
            })}
          >
            マイク: {mic ? "ON" : "OFF"}
          </button>
          <button
            disabled={busy}
            onClick={wrap(async () => {
              await controller.toggleCamera(!camera);
              setCamera(!camera);
            })}
          >
            カメラ: {camera ? "ON" : "OFF"}
          </button>
          <button
            disabled={busy}
            onClick={wrap(async () => {
              await controller.toggleScreenShare(!screen);
              setScreen(!screen);
            })}
          >
            画面共有: {screen ? "ON" : "OFF"}
          </button>

          <div className="slides">
            <button
              disabled={busy}
              onClick={wrap(async () => setPage(await controller.slidePrev()))}
            >
              ◀ 前
            </button>
            <span>スライド {page}</span>
            <button
              disabled={busy}
              onClick={wrap(async () => setPage(await controller.slideNext()))}
            >
              次 ▶
            </button>
          </div>
        </section>
      ) : (
        <p>モデレーターとして進行を補助します。</p>
      )}

      <button
        className="leave"
        disabled={busy}
        onClick={wrap(() => controller.leave().then(() => setSession(undefined)))}
      >
        退室
      </button>
    </main>
  );
}
