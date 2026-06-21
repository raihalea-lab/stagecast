/**
 * LayoutControl - admin-web から composer-template に layout 切替を broadcast する (R16, ADR 0012 D-4)。
 *
 * 流れ:
 *  1. event.id から control-api `/events/{id}/admin-token` で admin role token を取得
 *  2. livekit-client で room.connect (admin identity)
 *  3. layout ボタン押下 → `localParticipant.publishData(encoded)` で broadcast
 *  4. composer-template が `RoomEvent.DataReceived` で受信 → React state 更新 → layout 切替
 *
 * admin-web は room に participant として join するが publish しない (subscribe-only 動作)。
 * ただし LiveKit role が `admin` なので canPublish:true (将来 R17 でプレビューに subscribe する)。
 */
import { useCallback, useEffect, useState } from "react";
import { Room, RoomEvent } from "livekit-client";
import {
  ALL_LAYOUTS,
  encodeLayoutMessage,
  LAYOUT_LABELS,
  type LayoutKind,
} from "@stagecast/shared";
import type { ControlApiClient } from "../api/types.js";
import { toErrorMessage } from "../lib/errors.js";

interface Props {
  eventId: string;
  client: ControlApiClient;
}

export function LayoutControl(props: Props) {
  const { eventId, client } = props;
  const [room] = useState(() => new Room({ adaptiveStream: false }));
  const [state, setState] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const [error, setError] = useState<string | undefined>();
  const [currentLayout, setCurrentLayout] = useState<LayoutKind>("grid");

  // 接続: マウント時に admin-token 取得 → room.connect。 切断時 (unmount or eventId 変更) は disconnect。
  useEffect(() => {
    let cancelled = false;
    setState("connecting");
    setError(undefined);
    room
      .on(RoomEvent.Disconnected, () => {
        if (!cancelled) setState("idle");
      })
      .on(RoomEvent.Reconnected, () => {
        if (!cancelled) setState("connected");
      });
    (async () => {
      try {
        const tokenResult = await client.issueAdminToken(eventId);
        if (cancelled) return;
        await room.connect(tokenResult.livekitUrl, tokenResult.livekitToken);
        if (cancelled) return;
        setState("connected");
      } catch (err) {
        if (cancelled) return;
        setState("error");
        setError(toErrorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
      void room.disconnect();
    };
  }, [room, eventId, client]);

  const changeLayout = useCallback(
    async (layout: LayoutKind) => {
      setError(undefined);
      try {
        const bytes = encodeLayoutMessage({ type: "layout-change", layout });
        // reliable: true で順序保証 + 配信失敗時のリトライ。 admin の操作なので確実性優先。
        await room.localParticipant.publishData(bytes, { reliable: true });
        setCurrentLayout(layout);
      } catch (err) {
        setError(toErrorMessage(err));
      }
    },
    [room],
  );

  return (
    <section className="layout-control">
      <h3>レイアウト切替 (配信中の合成画面)</h3>
      <p className="layout-control-status">
        {state === "idle" && "未接続"}
        {state === "connecting" && "接続中…"}
        {state === "connected" && (
          <span className="ok">✅ 接続済み (現在: {LAYOUT_LABELS[currentLayout]})</span>
        )}
        {state === "error" && <span className="error">❌ {error ?? "接続エラー"}</span>}
      </p>
      <div className="layout-control-buttons">
        {ALL_LAYOUTS.map((layout) => (
          <button
            key={layout}
            type="button"
            disabled={state !== "connected"}
            onClick={() => changeLayout(layout)}
            className={currentLayout === layout ? "active" : ""}
          >
            {LAYOUT_LABELS[layout]}
          </button>
        ))}
      </div>
      <p className="layout-control-hint">
        ※ event が live + EventMediaStack 起動完了後に接続が確立します。 切替は composer-template
        (Egress と admin-web/stage-web プレビュー) に即時反映されます (sub-second)。
      </p>
    </section>
  );
}
