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
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Room,
  RoomEvent,
  type RemoteParticipant,
  type RemoteTrackPublication,
} from "livekit-client";
import { decodeStageMessage, type LayoutKind } from "@stagecast/shared";
import { Grid } from "./layouts/Grid.js";
import { Pip } from "./layouts/Pip.js";
import { ScreenShareMain } from "./layouts/ScreenShareMain.js";
import { SlideLayout } from "./layouts/SlideLayout.js";
import { Spotlight } from "./layouts/Spotlight.js";
import { type VideoTile } from "./layouts/types.js";
import { Banner, type BannerState } from "./overlays/Banner.js";
import { Overlay, type OverlayState } from "./overlays/Overlay.js";
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
  // Phase 1: live speaker identities (visibility-change で更新)。空 = フィルタなし（全員表示）。
  const [liveIdentities, setLiveIdentities] = useState<Map<string, "live" | "standby">>(new Map());
  // Phase 3: バナー（下部テロップ）状態。
  const [bannerState, setBannerState] = useState<BannerState | null>(null);
  const handleBannerAutoHide = useCallback(() => setBannerState(null), []);
  // Phase 4: オーバーレイ（QRコード/画像/動画）状態。
  const [overlayState, setOverlayState] = useState<OverlayState | null>(null);
  const handleOverlayAutoHide = useCallback(() => setOverlayState(null), []);
  // F-3 / DESIGN.md 5.2: 事前アップロードスライド (PDF) のデッキ URL と表示ページ。
  const [slideUrl, setSlideUrl] = useState<string | undefined>(undefined);
  const [slidePage, setSlidePage] = useState(1);
  const [slideTotalPages, setSlideTotalPages] = useState(1);

  // postMessage ブリッジ: 同一 identity の DataChannel エコー問題を回避
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string } | undefined;
      if (typeof data !== "object" || !data?.type) return;
      if (data.type === "layout-change") {
        const d = data as { layout?: LayoutKind; focusIdentity?: string };
        if (d.layout) {
          setLayout(d.layout);
          setFocusIdentity(d.focusIdentity);
        }
      } else if (data.type === "banner-show") {
        const d = data as {
          text?: string;
          subtext?: string;
          position?: "bottom" | "top";
          autoHideMs?: number;
        };
        if (d.text) {
          setBannerState({
            text: d.text,
            subtext: d.subtext,
            position: d.position ?? "bottom",
            autoHideMs: d.autoHideMs,
          });
        }
      } else if (data.type === "banner-hide") {
        setBannerState(null);
      } else if (data.type === "overlay-show") {
        const d = data as {
          kind?: "qr" | "image" | "video";
          url?: string;
          position?: string;
          sizePercent?: number;
          autoHideMs?: number;
        };
        if (d.url && d.kind) {
          setOverlayState({
            kind: d.kind,
            url: d.url,
            position: (d.position as OverlayState["position"]) ?? "bottom-right",
            sizePercent: d.sizePercent,
            autoHideMs: d.autoHideMs,
          });
        }
      } else if (data.type === "overlay-hide") {
        setOverlayState(null);
      } else if (data.type === "visibility-change") {
        const d = data as { speakerId?: string; visibility?: "live" | "standby" };
        if (d.speakerId && d.visibility) {
          setLiveIdentities((prev) => {
            const next = new Map(prev);
            next.set(d.speakerId!, d.visibility!);
            return next;
          });
        }
      } else if (data.type === "slide-deck") {
        const d = data as { url?: string };
        if (d.url) {
          setSlideUrl(d.url);
          setSlidePage(1);
        }
      } else if (data.type === "slide-page") {
        const d = data as { page?: number };
        if (typeof d.page === "number" && d.page >= 1) {
          setSlidePage(d.page);
        }
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

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
      // R16 / ADR 0012 D-4: admin-web から data channel でメッセージを受信する。
      .on(RoomEvent.DataReceived, (payload: Uint8Array, _participant?: RemoteParticipant) => {
        if (cancelled) return;
        const msg = decodeStageMessage(payload);
        if (!msg) return;
        if (msg.type === "layout-change") {
          setLayout(msg.layout);
          setFocusIdentity(msg.focusIdentity);
        } else if (msg.type === "visibility-change") {
          setLiveIdentities((prev) => {
            const next = new Map(prev);
            next.set(msg.speakerId, msg.visibility);
            return next;
          });
        } else if (msg.type === "banner-show") {
          setBannerState({
            text: msg.text,
            subtext: msg.subtext,
            position: msg.position,
            autoHideMs: msg.autoHideMs,
          });
        } else if (msg.type === "banner-hide") {
          setBannerState(null);
        } else if (msg.type === "overlay-show") {
          setOverlayState({
            kind: msg.kind,
            url: msg.url,
            position: msg.position,
            sizePercent: msg.sizePercent,
            autoHideMs: msg.autoHideMs,
          });
        } else if (msg.type === "overlay-hide") {
          setOverlayState(null);
        } else if (msg.type === "slide-deck") {
          setSlideUrl(msg.url);
          setSlidePage(1);
        } else if (msg.type === "slide-page") {
          setSlidePage(msg.page);
        }
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

  // Phase 1: visibility state でフィルタ。visibility-change を一度でも受信したらフィルタ有効。
  const visibleTiles = useMemo(() => {
    if (liveIdentities.size === 0) return tiles;
    return tiles.filter((t) => {
      const vis = liveIdentities.get(t.participant.identity);
      return vis === undefined || vis === "live";
    });
  }, [tiles, liveIdentities]);

  const view = useMemo(() => {
    if (state === "error") {
      return (
        <div style={{ color: "#fff", padding: 24 }}>Connection error: {errorMsg ?? "unknown"}</div>
      );
    }
    // F-3 / DESIGN.md 5.2: 事前アップロードスライドが読み込まれていれば slide を main に表示。
    if (slideUrl) {
      return (
        <SlideLayout
          tiles={visibleTiles}
          url={slideUrl}
          page={slidePage}
          onTotalPages={setSlideTotalPages}
        />
      );
    }
    if (visibleTiles.length === 0) {
      return <WaitingScreen />;
    }
    switch (layout) {
      case "spotlight":
        return <Spotlight tiles={visibleTiles} focusIdentity={focusIdentity} />;
      case "pip":
        return <Pip tiles={visibleTiles} focusIdentity={focusIdentity} />;
      case "screen-share-main":
        return <ScreenShareMain tiles={visibleTiles} />;
      case "grid":
      default:
        return <Grid tiles={visibleTiles} />;
    }
  }, [state, errorMsg, visibleTiles, layout, focusIdentity, slideUrl, slidePage]);

  return (
    <div className="composer-root" style={{ position: "relative" }}>
      {view}
      <Banner banner={bannerState} onAutoHide={handleBannerAutoHide} />
      <Overlay overlay={overlayState} onAutoHide={handleOverlayAutoHide} />
    </div>
  );
}
