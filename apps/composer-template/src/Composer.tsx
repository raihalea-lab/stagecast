/**
 * Composer - LiveKit room に接続して全 participant の track を合成描画するハブ (ADR 0012 D-1, D-4)。
 *
 * R15: 接続管理 + grid layout + 待機画面 + START_RECORDING シグナル。
 * R16: data channel で layout 切替を受信 + grid/spotlight/pip/screen-share-main の 4 種類。
 * R17 (将来): iframe プレビュー用の subscriber-only 起動モード。
 *
 * 描画ロジック:
 *  - tiles (= video publication) が 0 なら `<WaitingScreen />` (要件 3 fallback)
 *  - 1 以上なら現在の layout で描画 (admin-web からの broadcast で切替可)
 *
 * Egress 自身も participant として join するが、 `Hidden: true` token で room の
 * participant 数にはカウントされない (livekit-server-sdk の egress role)。
 * よって tiles = video track を 1 個以上 publish している participant の publication 数。
 */
import { useEffect, useMemo, useState } from "react";
import {
  Room,
  RoomEvent,
  type RemoteParticipant,
  type RemoteTrackPublication,
} from "livekit-client";
import { decodeLayoutMessage, type LayoutKind } from "@stagecast/shared";
import { Grid } from "./layouts/Grid.js";
import { Pip } from "./layouts/Pip.js";
import { ScreenShareMain } from "./layouts/ScreenShareMain.js";
import { Spotlight } from "./layouts/Spotlight.js";
import { type VideoTile } from "./layouts/types.js";
import { WaitingScreen } from "./WaitingScreen.js";

interface Props {
  token: string;
  url: string;
  initialLayout: LayoutKind;
}

export function Composer(props: Props) {
  const [room] = useState(() => new Room({ adaptiveStream: true }));
  const [state, setState] = useState<"connecting" | "connected" | "disconnected" | "error">(
    "connecting",
  );
  const [errorMsg, setErrorMsg] = useState<string | undefined>();
  // R15-followup-3: 1 video publication = 1 tile (StreamYard 風)。
  const [tiles, setTiles] = useState<readonly VideoTile[]>([]);
  // R16: layout state + focus 指定 (admin-web からの broadcast で更新)。
  const [layout, setLayout] = useState<LayoutKind>(props.initialLayout);
  const [focusIdentity, setFocusIdentity] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      const next: VideoTile[] = [];
      for (const p of room.remoteParticipants.values()) {
        for (const pub of p.videoTrackPublications.values()) {
          if (!pub.isMuted) {
            next.push({ participant: p, publication: pub as RemoteTrackPublication });
          }
        }
      }
      setTiles(next);
    };
    room
      .on(RoomEvent.Connected, () => {
        if (cancelled) return;
        setState("connected");
        refresh();
        // R15-followup-1: Egress に「描画開始」を通知する (pkg/source/web.go の
        // startRecordingLog 監視で GStreamer pipeline が playing 状態に遷移する)。
        // eslint-disable-next-line no-console
        console.log("START_RECORDING");
      })
      .on(RoomEvent.Disconnected, () => {
        if (cancelled) return;
        setState("disconnected");
        setTiles([]);
        // R15-followup-1: Egress に「録画終了」を通知する。
        // eslint-disable-next-line no-console
        console.log("END_RECORDING");
      })
      .on(RoomEvent.ParticipantConnected, refresh)
      .on(RoomEvent.ParticipantDisconnected, refresh)
      .on(RoomEvent.TrackPublished, refresh)
      .on(RoomEvent.TrackUnpublished, refresh)
      .on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.TrackUnmuted, refresh)
      // R15-followup-2: TrackSubscribed/Unsubscribed も refresh のトリガーにする
      // (adaptiveStream: true の SFU が mute 時に track を自動 unsubscribe するため)。
      .on(RoomEvent.TrackSubscribed, refresh)
      .on(RoomEvent.TrackUnsubscribed, refresh)
      // R16 / ADR 0012 D-4: admin-web から data channel で layout 切替を受信する。
      // 全 participant の broadcast を listen し、 不明な payload は無視 (decode が null を返す)。
      .on(RoomEvent.DataReceived, (payload: Uint8Array, _participant?: RemoteParticipant) => {
        const msg = decodeLayoutMessage(payload);
        if (!msg || cancelled) return;
        setLayout(msg.layout);
        setFocusIdentity(msg.focusIdentity);
      });
    // LiveKit Egress sidecar 構成 (ADR 0010 D-2) では url が ws://localhost:7880。
    // Chrome の LNA 制限は ADR 0010 D-7 の `insecure: true` で回避済み。
    room.connect(props.url, props.token).catch((err: unknown) => {
      if (cancelled) return;
      setState("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    });
    return () => {
      cancelled = true;
      void room.disconnect();
    };
  }, [room, props.url, props.token]);

  const view = useMemo(() => {
    if (state === "error") {
      return (
        <div style={{ color: "#fff", padding: 24 }}>Connection error: {errorMsg ?? "unknown"}</div>
      );
    }
    if (tiles.length === 0) {
      return <WaitingScreen />;
    }
    switch (layout) {
      case "spotlight":
        return <Spotlight tiles={tiles} focusIdentity={focusIdentity} />;
      case "pip":
        return <Pip tiles={tiles} focusIdentity={focusIdentity} />;
      case "screen-share-main":
        return <ScreenShareMain tiles={tiles} />;
      case "grid":
      default:
        return <Grid tiles={tiles} />;
    }
  }, [state, errorMsg, tiles, layout, focusIdentity]);

  return <div className="composer-root">{view}</div>;
}
