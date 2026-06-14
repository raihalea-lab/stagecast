/**
 * 登壇者・モデレーター用ステージ画面 (DESIGN.md 4.1, 5.2, F-1, F-3)。
 * 招待 URL のトークンで入室し、登壇者は映像音声・画面共有・スライド送りを操作する。
 */
import { useMemo, useState } from "react";
import { HttpStageClient, type StageClient } from "./api/stage-client.js";
import { LiveKitRoomConnector } from "./lib/livekit-room.js";
import type { RoomConnector } from "./lib/room.js";
import { StageController, type StageSession } from "./stage-controller.js";
import { parseInviteToken } from "./lib/token.js";

function defaultClient(): StageClient {
  const baseUrl = import.meta.env.VITE_CONTROL_API_URL ?? "";
  return new HttpStageClient(baseUrl);
}

export function App(props: { client?: StageClient; room?: RoomConnector; search?: string }) {
  const controller = useMemo(
    () =>
      new StageController(
        props.client ?? defaultClient(),
        props.room ?? new LiveKitRoomConnector(),
      ),
    [props.client, props.room],
  );
  const initialToken = parseInviteToken(props.search ?? window.location.search) ?? "";

  const [token, setToken] = useState(initialToken);
  const [name, setName] = useState("");
  const [session, setSession] = useState<StageSession | undefined>();
  const [error, setError] = useState<string>();
  const [mic, setMic] = useState(false);
  const [camera, setCamera] = useState(false);
  const [screen, setScreen] = useState(false);
  const [page, setPage] = useState(1);

  const join = async () => {
    setError(undefined);
    const res = await controller.join(token, name || undefined);
    if (!res.ok) {
      setError(`入室できません: ${res.reason}`);
      return;
    }
    setSession(controller.currentSession);
  };

  const wrap = (fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!session) {
    return (
      <main className="join">
        <h1>Stagecast ステージ入室</h1>
        {error && <p className="error">{error}</p>}
        <label>
          招待トークン
          <input value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
        <label>
          表示名
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button onClick={join} disabled={!token}>
          入室する
        </button>
      </main>
    );
  }

  return (
    <main className="stage">
      <h1>
        {session.role === "speaker" ? "登壇者" : "モデレーター"} / イベント {session.eventId}
      </h1>
      {error && <p className="error">{error}</p>}

      {session.canPublish ? (
        <section className="controls">
          <button
            onClick={wrap(async () => {
              await controller.toggleMic(!mic);
              setMic(!mic);
            })}
          >
            マイク: {mic ? "ON" : "OFF"}
          </button>
          <button
            onClick={wrap(async () => {
              await controller.toggleCamera(!camera);
              setCamera(!camera);
            })}
          >
            カメラ: {camera ? "ON" : "OFF"}
          </button>
          <button
            onClick={wrap(async () => {
              await controller.toggleScreenShare(!screen);
              setScreen(!screen);
            })}
          >
            画面共有: {screen ? "ON" : "OFF"}
          </button>

          <div className="slides">
            <button onClick={wrap(async () => setPage(await controller.slidePrev()))}>◀ 前</button>
            <span>スライド {page}</span>
            <button onClick={wrap(async () => setPage(await controller.slideNext()))}>次 ▶</button>
          </div>
        </section>
      ) : (
        <p>モデレーターとして進行を補助します。</p>
      )}

      <button
        className="leave"
        onClick={wrap(() => controller.leave().then(() => setSession(undefined)))}
      >
        退室
      </button>
    </main>
  );
}
