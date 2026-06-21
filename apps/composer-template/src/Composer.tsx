/**
 * Composer - LiveKit room に接続して全 participant の track を合成描画するハブ (ADR 0012 D-1)。
 *
 * R15: 接続管理 + grid layout のみ。 R16 で layout 切替 (LiveKit data channel)、
 * R17 で iframe プレビュー (subscriber-only token) を追加する。
 *
 * 描画ロジック:
 *  - publishing participant が 1 人以上 → 選択中の layout で video tile を表示
 *  - publishing participant が 0 人 → `<WaitingScreen />` (要件 3: イベント中 fallback)
 *
 * Egress 自身も participant として join するが、 `Hidden: true` token で room の
 * participant 数にはカウントされない (livekit-server-sdk の egress role)。
 * よって publishing = video track を 1 個以上 publish している participant の数。
 *
 * R15-followup-1: LiveKit Egress プロトコル準拠 (pkg/source/web.go の startRecordingLog 監視)。
 * カスタムテンプレートは Room.connect 成功時点で `console.log("START_RECORDING")` を発行する
 * 必要があり、 これを Egress が console event として検出して GStreamer pipeline を playing 状態に
 * 遷移させる。 発行しないと Egress は `request validated` 後 awaitStartSignal で永遠に
 * 待機し、 `pipeline playing` まで進まず YouTube に何も届かない。
 *
 * 我々の要件 3 (待機画面でも配信継続) のため、 participant の数や track の有無を待たず、
 * Room.connect 成功時点で無条件に START_RECORDING を発行する (公式テンプレートは
 * framesDecoded > 0 を待つが、 我々は待機画面を録画したいので即発行)。
 */
import { useEffect, useMemo, useState } from "react";
import { Room, RoomEvent, type Participant } from "livekit-client";
import { Grid } from "./layouts/Grid.js";
import { WaitingScreen } from "./WaitingScreen.js";

export type LayoutKind = "grid";

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
  // publishing participant = video track を 1 個以上 publish している participant。
  // `useState<readonly Participant[]>` で安定参照を管理し、 layout に props で渡す。
  const [publishers, setPublishers] = useState<readonly Participant[]>([]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      // Egress 自身は subscriber-only (camPublish=false) なので、 publishVideoTrackCount は 0。
      // remoteParticipants だけ見て publishing 数を集計する。
      const pubs: Participant[] = [];
      for (const p of room.remoteParticipants.values()) {
        if (Array.from(p.videoTrackPublications.values()).some((t) => !t.isMuted)) {
          pubs.push(p);
        }
      }
      setPublishers(pubs);
    };
    room
      .on(RoomEvent.Connected, () => {
        if (cancelled) return;
        setState("connected");
        refresh();
        // R15-followup-1: Egress に「描画開始」を通知する (pkg/source/web.go の
        // startRecordingLog 監視で GStreamer pipeline が playing 状態に遷移する)。
        // この console.log を発行しないと Egress は awaitStartSignal で永遠に待機する。
        // eslint-disable-next-line no-console
        console.log("START_RECORDING");
      })
      .on(RoomEvent.Disconnected, () => {
        if (cancelled) return;
        setState("disconnected");
        setPublishers([]);
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
      // R15-followup-2: TrackSubscribed/Unsubscribed も refresh のトリガーにする。
      // adaptiveStream: true の SFU は不要なトラックを自動 unsubscribe するため、
      // mute → unmute サイクルで一度 unsubscribe → 再 subscribe が走るケースがある。
      // これを refresh で拾わないと publishers state が古い track 参照を保持したまま、
      // Grid の Tile が再 attach できず video が灰色のままになる。
      .on(RoomEvent.TrackSubscribed, refresh)
      .on(RoomEvent.TrackUnsubscribed, refresh);
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
        <div style={{ color: "#fff", padding: 24 }}>
          Connection error: {errorMsg ?? "unknown"}
        </div>
      );
    }
    if (publishers.length === 0) {
      return <WaitingScreen />;
    }
    // R15 は grid のみ。 R16 で layout 切替を追加。
    return <Grid publishers={publishers} />;
  }, [state, errorMsg, publishers]);

  return <div className="composer-root">{view}</div>;
}
