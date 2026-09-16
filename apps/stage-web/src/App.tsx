/**
 * ステージ画面 — ロール別サブビュー (DESIGN.md 4.1, 5.2, F-1, F-3, ADR 0014)。
 *
 * D7: StageShell + ControlBar ベースの Speaker サブビュー。
 * D8: Moderator サブビュー (2 カラム: PreviewWindow + ParticipantList + LayoutPicker)。
 * D9: Admin サブビュー (LivePreview + LifecycleControl + EgressControl + LiveStats + RoleSwitcher)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HttpStageClient, type StageClient } from "./api/stage-client.js";
import { LiveKitRoomConnector } from "./lib/livekit-room.js";
import { BrowserMediaDevicesProvider } from "./lib/browser-devices.js";
import type { MediaDevicesProvider, PreferredDevices } from "./lib/devices.js";
import type { ParticipantSnapshot, RoomConnector } from "./lib/room.js";
import { StageController, type StageSession } from "./stage-controller.js";
import { parseAdminDirectParams, parseInviteToken } from "./lib/token.js";
import { DeviceCheck } from "./components/DeviceCheck.js";
import { PreviewWindow } from "./components/PreviewWindow.js";
import type { RuntimeConfig } from "./config.js";
import {
  decodeStageMessage,
  isSameDeck,
  materialKey,
  type AssetMetadata,
  type DeckRef,
  type EffectConfig,
  type LayoutKind,
  type Preset,
  type StageRole,
} from "@stagecast/shared";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ChatPanel,
  ControlBar,
  EgressControl,
  Input,
  Label,
  LayoutPicker,
  LifecycleControl,
  LiveStats,
  ParticipantList,
  ProductionControl,
  ReconnectingBanner,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  RoleSwitcher,
  Separator,
  Sheet,
  SheetContent,
  SheetTrigger,
  StageShell,
  StatusPill,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type ChatMessageDisplay,
  type EgressState,
  type LiveStatsData,
  type ParticipantInfo,
  type RoomState,
  type TensionState,
} from "@stagecast/ui";
import {
  Camera,
  CameraOff,
  ChevronLeft,
  ChevronRight,
  LogOut,
  MessageCircle,
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
  Upload,
  X,
} from "@stagecast/ui/icons";

/**
 * デッキ状態を配り直す間隔 (F-3, ADR 0022 D-1)。
 *
 * composer は room metadata で状態を読むようになったので、**追いつくための配り直しは不要**。
 * 残っているのは署名付き URL の更新のためだけ (presign は 15 分で失効する)。
 * 元は 15 秒だった。
 */
const DECK_REPLAY_INTERVAL_MS = 5 * 60_000;
/** 署名付き GET URL を取り直す閾値。control-api の presign は 15 分で失効する。 */
const DECK_URL_MAX_AGE_MS = 10 * 60_000;
// participant の入室通知は「room に join した」時点で届くので、相手の composer が
// DataReceived を購読し終える前に配ってしまうことがある。少し待ってから配り直す。
const PARTICIPANT_REPLAY_DELAY_MS = 500;

function toParticipantInfo(
  s: ParticipantSnapshot,
  visibilityMap: Map<string, "live" | "standby">,
): ParticipantInfo {
  const role = s.identity.startsWith("speaker-")
    ? ("speaker" as const)
    : s.identity.startsWith("moderator-")
      ? ("moderator" as const)
      : s.identity.startsWith("admin-")
        ? ("admin" as const)
        : undefined;
  return { ...s, role, visibility: visibilityMap.get(s.identity) };
}

const ROLE_LABELS: Record<StageRole, string> = {
  speaker: "登壇者",
  moderator: "モデレーター",
  admin: "管理者",
};

export function App(props: {
  config?: RuntimeConfig;
  client?: StageClient;
  room?: RoomConnector;
  search?: string;
  devices?: MediaDevicesProvider;
}) {
  const client = useMemo(
    () => props.client ?? new HttpStageClient(props.config?.controlApiUrl ?? ""),
    [props.client, props.config],
  );
  const controller = useMemo(
    () => new StageController(client, props.room ?? new LiveKitRoomConnector()),
    [client, props.room],
  );
  const deviceProvider = useMemo(
    () => props.devices ?? new BrowserMediaDevicesProvider(),
    [props.devices],
  );

  const searchStr = props.search ?? window.location.search;
  const adminDirect = useMemo(() => parseAdminDirectParams(searchStr), [searchStr]);
  const initialToken = parseInviteToken(searchStr) ?? "";

  const [token, setToken] = useState(initialToken);
  const [name, setName] = useState("");
  const [session, setSession] = useState<StageSession | undefined>();
  // admin 直接接続 (ADR 0014 D-4) では ?token= が LiveKit JWT なので招待トークンとして使わない。
  // ponytail: admin はプリセット/アセットがローカル限定。管理者資格情報で stage ルートを叩けるようにするのが本来の解。
  const inviteToken = session?.role === "admin" ? "" : token;
  const [myIdentity, setMyIdentity] = useState<string>("");
  const [viewAsRole, setViewAsRole] = useState<StageRole>("admin");
  const [error, setError] = useState<string>();
  const [prefs, setPrefs] = useState<PreferredDevices>({});
  const [mic, setMic] = useState(false);
  const [camera, setCamera] = useState(false);
  const [screen, setScreen] = useState(false);
  const [page, setPage] = useState(1);
  const [reconnecting, setReconnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retryInfo, setRetryInfo] = useState<
    { attempt: number; nextWaitSec: number; elapsedSec: number } | undefined
  >();
  const [participants, setParticipants] = useState<ParticipantSnapshot[]>([]);
  const [layout, setLayout] = useState<LayoutKind>("grid");
  const [focusIdentity, setFocusIdentity] = useState<string | undefined>();
  const [speakerVisibility, setSpeakerVisibility] = useState<Map<string, "live" | "standby">>(
    new Map(),
  );
  const [chatMessages, setChatMessages] = useState<ChatMessageDisplay[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [stageAssets, setStageAssets] = useState<AssetMetadata[]>([]);
  // F-3 / DESIGN.md 5.2: 事前アップロードスライド (PDF) のデッキ選択状態。
  const [deckKey, setDeckKey] = useState<string | undefined>();
  const [deckUrl, setDeckUrl] = useState<string | undefined>();
  // F-3: PDF の総ページ数。stage-web が pdf.js で解決して StageController に渡す。
  const [deckTotalPages, setDeckTotalPages] = useState(1);
  const deckInputRef = useRef<HTMLInputElement>(null);
  // 現在のデッキ URL を発行した時刻 (署名付き URL の失効前に取り直すため)。
  const deckUrlIssuedAtRef = useRef(0);
  // 入室検知ハンドラは mount 時に 1 回だけ登録するので、最新の replayDeck を ref 越しに呼ぶ。
  const replayDeckRef = useRef<() => Promise<void>>(async () => {});
  // 受信ハンドラも mount 時に 1 回だけ登録するので、現在のデッキ URL を ref で読む。
  const deckUrlRef = useRef<string | undefined>(undefined);
  // ADR 0022 D-1: 投影中のデッキ参照。ページ送りのたびにサーバーへ添えて送る。
  const deckAssetRef = useRef<DeckRef | undefined>(undefined);
  const [muteNotice, setMuteNotice] = useState<string | undefined>();
  const [roomState, setRoomState] = useState<RoomState>("stopped");
  const [egressState, setEgressState] = useState<EgressState>("idle");
  const [elapsedSec, setElapsedSec] = useState(0);
  const elapsedRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const previewIframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    controller.onDisconnected(() => {
      setSession(undefined);
      setReconnecting(false);
      setRoomState("stopped");
      clearInterval(elapsedRef.current);
      setError("配信サーバから切断されました。もう一度入室してください。");
    });
    controller.onReconnecting(() => setReconnecting(true));
    controller.onReconnected(() => setReconnecting(false));
    controller.onParticipantsChanged((next, joined) => {
      setParticipants(next);
      // プレビューの composer は hidden ではないので入室を検知できる。待たずに配り直す
      // (hidden な egress composer は従来どおりハートビートが拾う)。
      if (joined.length > 0) {
        setTimeout(() => {
          void replayDeckRef.current().catch(() => {});
        }, PARTICIPANT_REPLAY_DELAY_MS);
      }
    });
    controller.onDataReceived((payload) => {
      const msg = decodeStageMessage(payload);
      if (!msg) return;
      if (msg.type === "mute-request") {
        setMuteNotice("モデレーターからミュート要請がありました");
        setTimeout(() => setMuteNotice(undefined), 5000);
      } else if (msg.type === "force-mute") {
        void controller.toggleMic(false).then(() => setMic(false));
        setMuteNotice("管理者によりマイクがミュートされました");
        setTimeout(() => setMuteNotice(undefined), 5000);
      } else if (msg.type === "visibility-change") {
        setSpeakerVisibility((prev) => {
          const next = new Map(prev);
          next.set(msg.speakerId, msg.visibility);
          return next;
        });
      } else if (msg.type === "slide-deck") {
        // モデレーターが投入したデッキを登壇者も持つ (F-3)。これが無いと登壇者は総ページ数を
        // 知らず、自分でめくれない。同じデッキの配り直し (15 秒ごと) は無視する
        // ── 無視しないと投影中に自分のページ表示が 1 に戻り続ける。
        if (deckUrlRef.current && isSameDeck(deckUrlRef.current, msg.url)) return;
        deckUrlRef.current = msg.url;
        setDeckUrl(msg.url);
        setDeckTotalPages(msg.totalPages);
        controller.setDeck(msg.totalPages);
        setPage(1);
      } else if (msg.type === "slide-page") {
        setPage(controller.applyRemotePage(msg.page));
      } else if (msg.type === "slide-hide") {
        deckUrlRef.current = undefined;
        setDeckUrl(undefined);
        setDeckTotalPages(1);
        controller.setDeck(1);
        setPage(1);
      } else if (msg.type === "chat") {
        setChatMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          const role = msg.senderIdentity.startsWith("admin-")
            ? ("admin" as const)
            : msg.senderIdentity.startsWith("moderator-")
              ? ("moderator" as const)
              : ("speaker" as const);
          return [
            ...prev,
            {
              id: msg.id,
              senderIdentity: msg.senderIdentity,
              senderName: msg.senderName,
              senderRole: role,
              text: msg.text,
              timestampMs: msg.timestampMs,
            },
          ];
        });
      }
    });
  }, [controller]);

  // Admin 直接接続: URL に livekitUrl + token + eventId がある場合は自動入室
  const adminConnectAttempted = useRef(false);
  useEffect(() => {
    if (!adminDirect || adminConnectAttempted.current) return;
    adminConnectAttempted.current = true;
    setBusy(true);
    controller
      .connectAdmin(adminDirect.livekitUrl, adminDirect.livekitToken, adminDirect.eventId)
      .then(() => {
        setSession(controller.currentSession);
        setMyIdentity(adminDirect.eventId);
        setRoomState("running");
        elapsedRef.current = setInterval(() => setElapsedSec((s) => s + 1), 1000);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setBusy(false));
  }, [adminDirect, controller]);

  const join = async () => {
    setError(undefined);
    setRetryInfo(undefined);
    setBusy(true);
    try {
      controller.setPreferredDevices(prefs);
      const res = await controller.join(token, name || undefined, {
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
      setMyIdentity(res.identity);
    } finally {
      setBusy(false);
      setRetryInfo(undefined);
    }
  };

  // プリセット・アセットのロード（セッション確立後）
  useEffect(() => {
    if (!session || !inviteToken) return;
    void client
      .listPresets(inviteToken)
      .then(setPresets)
      .catch(() => {});
    void client
      .listAssets(inviteToken)
      .then(setStageAssets)
      .catch(() => {});
  }, [session, client, inviteToken]);

  const handleCreatePreset = useCallback(
    (label: string, config: EffectConfig) => {
      if (!session) return;
      if (!inviteToken) {
        // admin 直接接続の場合はローカルのみに追加
        setPresets((prev) => [
          ...prev,
          {
            presetId: `local-${Date.now()}`,
            eventId: session.eventId,
            config,
            label,
            sortOrder: prev.length,
            createdAt: new Date().toISOString(),
          },
        ]);
        return;
      }
      void client
        .createPreset(inviteToken, label, config)
        .then((preset) => {
          setPresets((prev) => [...prev, preset]);
        })
        .catch(() => {});
    },
    [session, client, inviteToken],
  );

  const handleDeletePreset = useCallback(
    (presetId: string) => {
      setPresets((prev) => prev.filter((p) => p.presetId !== presetId));
      if (inviteToken) {
        void client.deletePreset(inviteToken, presetId).catch(() => {});
      }
    },
    [client, inviteToken],
  );

  const handleResolveAssetUrl = useCallback(
    async (assetKey: string): Promise<string> => {
      if (!inviteToken) return "";
      return client.getAssetDownloadUrl(inviteToken, assetKey);
    },
    [client, inviteToken],
  );

  // F-3 / DESIGN.md 5.2: PDF をアップロードしてデッキとして選択し、composer に通知する。
  const handleUploadDeck = useCallback(
    async (file: File) => {
      if (!inviteToken) return;
      // 総ページ数を先に解決する: 読めない PDF はアップロードせずここで失敗させる。
      // これが無いと deck は totalPages=1 のままになり、2 ページ目以降に送れない。
      const { resolvePdfPageCount } = await import("./lib/pdf-pages.js");
      const totalPages = await resolvePdfPageCount(file);

      const { assetId, uploadUrl, key } = await client.getMaterialUploadUrl(inviteToken, file.name);
      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "content-type": "application/pdf" },
      });
      // 失敗を見ずに slide-deck を配ると composer が配信画面いっぱいにエラーを出す。
      if (!putRes.ok) throw new Error(`deck upload failed: ${putRes.status}`);
      const deck = { assetId, filename: file.name, pageCount: totalPages };
      // 投影の登録はサーバーが正 (ADR 0022 D-1)。ここは**待つ**: 失敗を握り潰すと、
      // 投影できているのに次の再読み込みで消えるという分かりにくい壊れ方になる。
      // 署名付き URL も応答で返るので、presign を 2 回叩かずに済む。
      const state = await client.setSlideState(inviteToken, {
        slideSource: "uploaded",
        slidePage: 1,
        deck,
      });
      const downloadUrl = state.deckUrl;
      if (!downloadUrl) throw new Error("deck url was not issued");
      deckAssetRef.current = deck;
      setDeckKey(key);
      setDeckUrl(downloadUrl);
      deckUrlIssuedAtRef.current = Date.now();
      setDeckTotalPages(totalPages);
      // setDeck が deck を 1 ページ目に戻すので setDeckUrl より先に呼ぶ
      // (setDeckUrl は totalPages を維持する)。composer も slide-deck 受信で 1 に戻る。
      controller.setDeck(totalPages);
      await controller.setDeckUrl(downloadUrl);
      setPage(1);
    },
    [client, inviteToken, controller],
  );

  /**
   * 入室時にサーバーの投影状態を読んで復元する (ADR 0022 D-1)。
   *
   * 投影の正はサーバーにあるので、**配り直しを待たずに**現在のデッキとページが分かる。
   * これが無いと、モデレーターが再読み込みしただけで手元からデッキが消え、
   * 投影中なのにページを送れなくなる。
   */
  useEffect(() => {
    if (!session || !inviteToken) return;
    let cancelled = false;
    void (async () => {
      const state = await client.getPresentationState(inviteToken).catch(() => undefined);
      if (cancelled || !state) return;
      if (state.slideSource !== "uploaded" || !state.deck) return;
      deckAssetRef.current = state.deck;
      setDeckTotalPages(state.deck.pageCount);
      controller.setDeck(state.deck.pageCount);
      setPage(controller.applyRemotePage(state.slidePage ?? 1));
      // URL は moderator にしか発行されない (資料のダウンロードは moderator 限定)。
      // speaker はページ数と現在ページだけ復元すればめくれる。
      if (!state.deckUrl) return;
      deckUrlRef.current = state.deckUrl;
      deckUrlIssuedAtRef.current = Date.now();
      setDeckKey(materialKey(state.eventId, state.deck.assetId, state.deck.filename));
      setDeckUrl(state.deckUrl);
    })();
    return () => {
      cancelled = true;
    };
  }, [session, inviteToken, client, controller]);

  // 投影中のデッキ状態を配り直す (F-3)。slide-deck は一度きりの broadcast なので、
  // 「デッキ投入 → 配信開始」の順で操作されると後から来た composer が投影を受け取れない。
  // composer は同じ PDF の再配布を無視するので、投影中の画面はちらつかない。
  const replayDeck = useCallback(async () => {
    if (!session || !inviteToken || !deckKey || !deckUrl) return;
    let url = deckUrl;
    if (Date.now() - deckUrlIssuedAtRef.current > DECK_URL_MAX_AGE_MS) {
      // **読むだけ**。getPresentationState が presign し直し、room metadata も貼り直す
      // (ADR 0022 D-1)。ここで状態を書き戻すと、他の人がめくった直後に手元の古いページで
      // 上書きしてしまい、composer の投影が 1 ページ戻る。
      const state = await client.getPresentationState(inviteToken);
      if (state.deckUrl) {
        url = state.deckUrl;
        deckUrlIssuedAtRef.current = Date.now();
        setDeckUrl(url);
      }
    }
    await controller.republishDeck(url);
  }, [session, client, inviteToken, deckKey, deckUrl, controller]);

  useEffect(() => {
    replayDeckRef.current = replayDeck;
  }, [replayDeck]);

  useEffect(() => {
    deckUrlRef.current = deckUrl;
  }, [deckUrl]);

  // 署名付き URL を失効前に更新する (ADR 0022 D-1)。更新した URL は setSlideState 経由で
  // room metadata にも載るので、後から起動する composer は常に生きた URL を読む。
  useEffect(() => {
    if (!session || !deckKey || !deckUrl) return;
    const timer = setInterval(() => {
      // 失敗しても次の tick で再試行するので、配信中のバナーは出さない。
      void replayDeckRef.current().catch(() => {});
    }, DECK_REPLAY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [session, deckKey, deckUrl]);

  /**
   * ページ送りをサーバーに永続化する (ADR 0022 D-1, D-2)。
   *
   * DataChannel の通知は `controller.slideNext/Prev` が既に出しているので、ここは
   * 待たない。永続化が失敗しても、その場のクライアントには影響しない
   * (後から入る側が一時的に古いページを読むだけで、次の操作で収束する)。
   */
  const persistPage = useCallback(
    (nextPage: number): number => {
      if (inviteToken && deckAssetRef.current) {
        void client
          .setSlideState(inviteToken, {
            slideSource: "uploaded",
            slidePage: nextPage,
            deck: deckAssetRef.current,
          })
          .catch(() => {});
      }
      return nextPage;
    },
    [client, inviteToken],
  );

  // 投影解除: composer はデッキが載っている間 slide レイアウトを固定するので、
  // grid / 画面共有メインに戻すには明示的に解除する必要がある (F-3)。
  const handleClearDeck = useCallback(async () => {
    await controller.hideDeck();
    setDeckKey(undefined);
    setDeckUrl(undefined);
    setDeckTotalPages(1);
    setPage(1);
    deckAssetRef.current = undefined;
    // 解除もサーバーに反映する。残すと後から入ったクライアントが解除済みの PDF を読む。
    if (inviteToken) void client.setSlideState(inviteToken, {}).catch(() => {});
  }, [controller, client, inviteToken]);

  const wrap = useCallback(
    (fn: () => Promise<unknown>) => async () => {
      setBusy(true);
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const tension: TensionState = !session ? "offline" : reconnecting ? "reconnecting" : "live";

  const handleSendChat = useCallback(
    (text: string) => {
      void controller.sendChat(text, name || undefined).then((msg) => {
        setChatMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          const role = msg.senderIdentity.startsWith("admin-")
            ? ("admin" as const)
            : msg.senderIdentity.startsWith("moderator-")
              ? ("moderator" as const)
              : ("speaker" as const);
          return [
            ...prev,
            {
              id: msg.id,
              senderIdentity: msg.senderIdentity,
              senderName: msg.senderName,
              senderRole: role,
              text: msg.text,
              timestampMs: msg.timestampMs,
            },
          ];
        });
      });
    },
    [controller, name],
  );

  // --- 未入室画面 ---
  if (!session) {
    // Admin 自動接続中のローディング / エラー表示
    if (adminDirect) {
      return (
        <StageShell tension={tension}>
          <div className="mx-auto w-full max-w-md space-y-6 pt-8 text-center">
            <h1 className="text-2xl font-bold tracking-tight text-text-primary">
              {error ? "接続に失敗しました" : "管理者として接続中…"}
            </h1>
            {error && (
              <>
                <div
                  role="alert"
                  className="flex items-start gap-3 rounded-md border border-error/40 bg-error/10 px-4 py-3 text-sm text-error"
                >
                  <span className="flex-1">{error}</span>
                </div>
                <div className="flex justify-center gap-3">
                  <Button
                    onClick={() => {
                      setError(undefined);
                      adminConnectAttempted.current = false;
                      setBusy(true);
                      controller
                        .connectAdmin(
                          adminDirect.livekitUrl,
                          adminDirect.livekitToken,
                          adminDirect.eventId,
                        )
                        .then(() => {
                          setSession(controller.currentSession);
                          setMyIdentity(adminDirect.eventId);
                          setRoomState("running");
                          elapsedRef.current = setInterval(() => setElapsedSec((s) => s + 1), 1000);
                        })
                        .catch((e: unknown) => {
                          setError(e instanceof Error ? e.message : String(e));
                        })
                        .finally(() => setBusy(false));
                    }}
                    disabled={busy}
                  >
                    再試行
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      window.history.back();
                    }}
                  >
                    戻る
                  </Button>
                </div>
              </>
            )}
            {!error && busy && (
              <p className="text-sm text-text-secondary">配信サーバに接続しています…</p>
            )}
          </div>
        </StageShell>
      );
    }

    return (
      <StageShell tension={tension}>
        <div className="mx-auto w-full max-w-md space-y-6 pt-8">
          <div className="space-y-2 text-center">
            <h1 className="text-2xl font-bold tracking-tight text-text-primary">
              Stagecast ステージ入室
            </h1>
            <p className="text-sm text-text-secondary">招待トークンを入力してステージに参加</p>
          </div>

          {error && (
            <div
              role="alert"
              className="flex items-start gap-3 rounded-md border border-error/40 bg-error/10 px-4 py-3 text-sm text-error"
            >
              <span className="flex-1">{error}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="閉じる"
                onClick={() => setError(undefined)}
              >
                ×
              </Button>
            </div>
          )}

          {retryInfo && (
            <ReconnectingBanner
              kind="retry-progress"
              attempt={retryInfo.attempt}
              nextWaitSec={retryInfo.nextWaitSec}
              elapsedSec={retryInfo.elapsedSec}
              maxSec={60}
            />
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">接続情報</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2">
                <Label htmlFor="invite-token">招待トークン</Label>
                <Input
                  id="invite-token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="招待URLから自動入力されます"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="display-name">表示名</Label>
                <Input
                  id="display-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="任意"
                />
              </div>
            </CardContent>
          </Card>

          <DeviceCheck provider={deviceProvider} onChange={setPrefs} />

          <Button className="w-full" onClick={join} disabled={!token || busy}>
            {busy ? (retryInfo ? "配信準備待ち…" : "入室中…") : "入室する"}
          </Button>
        </div>
      </StageShell>
    );
  }

  // --- 入室後 ---
  const effectiveRole = session.role === "admin" ? viewAsRole : session.role;
  const currentIdentity = myIdentity || session.eventId;

  const chatPanel = (
    <ChatPanel
      messages={chatMessages}
      onSend={handleSendChat}
      currentIdentity={currentIdentity}
      className="h-full"
    />
  );

  const mediaControls = (
    <>
      <Button
        variant={mic ? "default" : "outline"}
        size="sm"
        disabled={busy}
        onClick={wrap(async () => {
          await controller.toggleMic(!mic);
          setMic(!mic);
        })}
        aria-label={mic ? "マイクをオフ" : "マイクをオン"}
      >
        {mic ? <Mic className="size-4" /> : <MicOff className="size-4" />}
        <span className="ml-1.5 hidden sm:inline">{mic ? "ON" : "OFF"}</span>
      </Button>
      <Button
        variant={camera ? "default" : "outline"}
        size="sm"
        disabled={busy}
        onClick={wrap(async () => {
          await controller.toggleCamera(!camera);
          setCamera(!camera);
        })}
        aria-label={camera ? "カメラをオフ" : "カメラをオン"}
      >
        {camera ? <Camera className="size-4" /> : <CameraOff className="size-4" />}
        <span className="ml-1.5 hidden sm:inline">{camera ? "ON" : "OFF"}</span>
      </Button>
      <Button
        variant={screen ? "default" : "outline"}
        size="sm"
        disabled={busy}
        onClick={wrap(async () => {
          await controller.toggleScreenShare(!screen);
          setScreen(!screen);
        })}
        aria-label={screen ? "画面共有を停止" : "画面共有を開始"}
      >
        {screen ? <Monitor className="size-4" /> : <MonitorOff className="size-4" />}
        <span className="ml-1.5 hidden sm:inline">画面</span>
      </Button>
    </>
  );

  // スライド操作は moderator 限定。control-api の /stage/materials/upload-url は moderator 以外を
  // 403 で返し、デッキ URL / 総ページ数を持つのも投入した端末だけなので、speaker ビューには
  // 押しても何も起きないボタンを置かない (moderator ビューからのみ描画する)。
  // デッキの投入・解除はモデレーター専用。control-api が deck の presign を moderator
  // ロールに限っている ("only moderator can access decks") ので、登壇者に出しても押せない。
  const deckControls = (
    <>
      <input
        ref={deckInputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void wrap(() => handleUploadDeck(file))();
          e.target.value = "";
        }}
      />
      <Button
        variant="outline"
        size="sm"
        disabled={busy || !inviteToken}
        onClick={() => deckInputRef.current?.click()}
        aria-label="スライド PDF をアップロード"
      >
        <Upload className="size-4" />
        <span className="ml-1.5 hidden sm:inline">デッキ</span>
      </Button>
      {deckKey && (
        <span
          className="max-w-[12ch] truncate font-mono text-xs text-text-secondary"
          title={deckKey}
        >
          {deckKey.split("/").pop()}
        </span>
      )}
      {deckUrl && (
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={busy}
          onClick={wrap(handleClearDeck)}
          aria-label="スライドの投影を解除"
          title="スライドの投影を解除"
        >
          <X className="size-4" />
        </Button>
      )}
    </>
  );

  // ページ送りは登壇者にも出す。自分の発表を自分でめくれないと画面共有に対する優位が
  // 無くなる (F-3, DESIGN.md 5.2)。デッキ状態は slide-deck の受信で同期している。
  const slidePageControls = deckUrl && (
    <>
      <div className="mx-1 h-6 w-px bg-line-1" aria-hidden />
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={busy || page <= 1}
          onClick={wrap(async () => setPage(persistPage(await controller.slidePrev())))}
          aria-label="前のスライド"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span
          className="min-w-[5ch] text-center font-mono text-xs tabular-nums text-text-secondary"
          aria-label={`スライド ${page} / ${deckTotalPages}`}
        >
          {page} / {deckTotalPages}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={busy || page >= deckTotalPages}
          onClick={wrap(async () => setPage(persistPage(await controller.slideNext())))}
          aria-label="次のスライド"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </>
  );

  const leaveButton = (
    <Button
      variant="destructive"
      size="sm"
      disabled={busy}
      onClick={wrap(() =>
        controller.leave().then(() => {
          setSession(undefined);
          clearInterval(elapsedRef.current);
        }),
      )}
    >
      <LogOut className="size-4" />
      <span className="ml-1.5">退室</span>
    </Button>
  );

  const headerContent = (
    <div className="flex w-full items-center justify-between">
      <div className="flex items-center gap-3">
        <h1 className="text-sm font-semibold text-text-primary">{session.eventId}</h1>
        <StatusPill variant={reconnecting ? "warn" : "live"} className="text-xs">
          {reconnecting ? "再接続中" : "LIVE"}
        </StatusPill>
      </div>
      <div className="flex items-center gap-2">
        {session.role === "admin" && (
          <RoleSwitcher value={viewAsRole} onChange={setViewAsRole} experimental />
        )}
        <StatusPill variant="muted" showDot={false} className="text-xs">
          {ROLE_LABELS[session.role]}
        </StatusPill>
      </div>
    </div>
  );

  const statusBanners = (
    <>
      {reconnecting && <ReconnectingBanner kind="reconnecting" className="mb-4" />}
      {muteNotice && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-3 rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning"
        >
          <span className="flex-1">{muteNotice}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="閉じる"
            onClick={() => setMuteNotice(undefined)}
          >
            ×
          </Button>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-3 rounded-md border border-error/40 bg-error/10 px-4 py-3 text-sm text-error"
        >
          <span className="flex-1">{error}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="閉じる"
            onClick={() => setError(undefined)}
          >
            ×
          </Button>
        </div>
      )}
    </>
  );

  const layoutPicker = (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">レイアウト</CardTitle>
      </CardHeader>
      <CardContent>
        <LayoutPicker
          value={layout}
          onChange={(next) => {
            setLayout(next);
            void controller.changeLayout(next, focusIdentity);
            previewIframeRef.current?.contentWindow?.postMessage(
              { type: "layout-change", layout: next, focusIdentity },
              "*",
            );
          }}
          disabled={busy}
        />
      </CardContent>
    </Card>
  );

  const participantList = (
    <ParticipantList
      participants={participants.map((p) => toParticipantInfo(p, speakerVisibility))}
      focusIdentity={focusIdentity}
      onFocus={(identity) => {
        const next = identity === focusIdentity ? undefined : identity;
        setFocusIdentity(next);
        void controller.changeLayout(layout, next);
      }}
      onRequestMute={(identity) => {
        void controller.requestMute(identity);
      }}
      onForceMute={(identity) => {
        void controller.forceMute(identity);
      }}
      onVisibilityChange={(identity, visibility) => {
        void controller.setSpeakerVisibility(identity, visibility, token || undefined);
      }}
      showVisibilityControl={effectiveRole === "admin" || effectiveRole === "moderator"}
    />
  );

  // --- Admin サブビュー ---
  if (effectiveRole === "admin") {
    const stats: LiveStatsData = {
      participantCount: participants.length,
      elapsedSec,
    };

    return (
      <StageShell
        tension={tension}
        header={headerContent}
        controlBar={
          <ControlBar>
            {mediaControls}
            <div className="flex-1" />
            {leaveButton}
          </ControlBar>
        }
      >
        {statusBanners}
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel defaultSize={65} minSize={40}>
            <div className="space-y-4 pr-4">
              {/* LivePreview: composer-template iframe */}
              <Card className="overflow-hidden" aria-label="配信プレビュー">
                <CardHeader className="flex-row items-center justify-between space-y-0">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-base">配信プレビュー</CardTitle>
                    <StatusPill variant="live" className="text-xs">
                      ON AIR
                    </StatusPill>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  {props.config?.composerTemplateUrl && adminDirect ? (
                    <div className="overflow-hidden rounded-lg border-2 border-tally-500 shadow-[0_0_12px_rgba(220,38,38,0.25)]">
                      <iframe
                        ref={previewIframeRef}
                        title="配信プレビュー (composer-template)"
                        src={`${props.config.composerTemplateUrl}?layout=${layout}&token=${encodeURIComponent(adminDirect.livekitToken)}&url=${encodeURIComponent(adminDirect.livekitUrl)}`}
                        className="block w-full bg-black"
                        style={{ aspectRatio: "16/9" }}
                        allow="autoplay"
                      />
                    </div>
                  ) : (
                    <div
                      className="flex items-center justify-center rounded-lg border border-line-2 bg-surface-2 text-sm text-text-tertiary"
                      style={{ aspectRatio: "16/9" }}
                    >
                      プレビュー準備中…
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={35} minSize={20}>
            <aside className="space-y-4 pl-4">
              <LifecycleControl
                state={roomState}
                elapsedSec={elapsedSec}
                participantCount={participants.length}
                onEnd={wrap(async () => {
                  await controller.leave();
                  setSession(undefined);
                  setRoomState("stopped");
                  clearInterval(elapsedRef.current);
                })}
              />
              <EgressControl
                state={egressState}
                targets={[
                  { kind: "youtube", label: "YouTube Live" },
                  { kind: "s3", label: "S3 録画" },
                ]}
                onStart={wrap(async () => {
                  setEgressState("active");
                })}
                onStop={wrap(async () => {
                  setEgressState("idle");
                })}
              />
              <Tabs defaultValue="control" className="w-full">
                <TabsList className="w-full">
                  <TabsTrigger value="control" className="flex-1">
                    コントロール
                  </TabsTrigger>
                  <TabsTrigger value="chat" className="flex-1">
                    チャット
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="control" className="space-y-4">
                  {layoutPicker}
                  <Separator />
                  {participantList}
                  <Separator />
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm">演出</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ProductionControl
                        presets={presets}
                        assets={stageAssets}
                        onCreatePreset={handleCreatePreset}
                        onDeletePreset={handleDeletePreset}
                        onResolveAssetUrl={handleResolveAssetUrl}
                        onShowBanner={(opts) => {
                          const msg = {
                            type: "banner-show",
                            text: opts.text,
                            subtext: opts.subtext,
                            position: opts.position,
                            autoHideMs: opts.autoHideMs,
                          };
                          void controller.showBanner(opts.text, {
                            subtext: opts.subtext,
                            position: opts.position,
                            autoHideMs: opts.autoHideMs,
                          });
                          previewIframeRef.current?.contentWindow?.postMessage(msg, "*");
                        }}
                        onHideBanner={() => {
                          void controller.hideBanner();
                          previewIframeRef.current?.contentWindow?.postMessage(
                            { type: "banner-hide" },
                            "*",
                          );
                        }}
                        onShowOverlay={(opts) => {
                          const msg = {
                            type: "overlay-show",
                            kind: opts.kind,
                            url: opts.url,
                            position: opts.position,
                            sizePercent: opts.sizePercent,
                            autoHideMs: opts.autoHideMs,
                          };
                          void controller.showOverlay(opts.kind, opts.url, {
                            position: opts.position,
                            sizePercent: opts.sizePercent,
                            autoHideMs: opts.autoHideMs,
                          });
                          previewIframeRef.current?.contentWindow?.postMessage(msg, "*");
                        }}
                        onHideOverlay={() => {
                          void controller.hideOverlay();
                          previewIframeRef.current?.contentWindow?.postMessage(
                            { type: "overlay-hide" },
                            "*",
                          );
                        }}
                        disabled={busy}
                      />
                    </CardContent>
                  </Card>
                  <LiveStats stats={stats} />
                </TabsContent>
                <TabsContent value="chat">{chatPanel}</TabsContent>
              </Tabs>
            </aside>
          </ResizablePanel>
        </ResizablePanelGroup>
      </StageShell>
    );
  }

  // --- Moderator サブビュー ---
  if (effectiveRole === "moderator") {
    return (
      <StageShell
        tension={tension}
        header={headerContent}
        controlBar={
          <ControlBar>
            {mediaControls}
            {deckControls}
            {slidePageControls}
            <div className="flex-1" />
            {leaveButton}
          </ControlBar>
        }
      >
        {statusBanners}
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel defaultSize={65} minSize={40}>
            <div className="space-y-4 pr-4">
              <PreviewWindow
                client={client}
                inviteToken={token}
                composerTemplateUrl={props.config?.composerTemplateUrl}
              />
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={35} minSize={20}>
            <aside className="space-y-4 pl-4">
              <Tabs defaultValue="control" className="w-full">
                <TabsList className="w-full">
                  <TabsTrigger value="control" className="flex-1">
                    コントロール
                  </TabsTrigger>
                  <TabsTrigger value="chat" className="flex-1">
                    チャット
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="control" className="space-y-4">
                  {layoutPicker}
                  <Separator />
                  {participantList}
                  <Separator />
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm">演出</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ProductionControl
                        presets={presets}
                        assets={stageAssets}
                        onCreatePreset={handleCreatePreset}
                        onDeletePreset={handleDeletePreset}
                        onResolveAssetUrl={handleResolveAssetUrl}
                        onShowBanner={(opts) => {
                          void controller.showBanner(opts.text, {
                            subtext: opts.subtext,
                            position: opts.position,
                            autoHideMs: opts.autoHideMs,
                          });
                        }}
                        onHideBanner={() => {
                          void controller.hideBanner();
                        }}
                        onShowOverlay={(opts) => {
                          void controller.showOverlay(opts.kind, opts.url, {
                            position: opts.position,
                            sizePercent: opts.sizePercent,
                            autoHideMs: opts.autoHideMs,
                          });
                        }}
                        onHideOverlay={() => {
                          void controller.hideOverlay();
                        }}
                        disabled={busy}
                      />
                    </CardContent>
                  </Card>
                </TabsContent>
                <TabsContent value="chat">{chatPanel}</TabsContent>
              </Tabs>
            </aside>
          </ResizablePanel>
        </ResizablePanelGroup>
      </StageShell>
    );
  }

  // --- Speaker サブビュー ---
  return (
    <StageShell
      tension={tension}
      header={headerContent}
      controlBar={
        <ControlBar>
          {mediaControls}
          {slidePageControls}
          <div className="flex-1" />
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline" size="sm">
                <MessageCircle className="size-4" />
                <span className="ml-1.5">チャット</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-80 p-0">
              {chatPanel}
            </SheetContent>
          </Sheet>
          {leaveButton}
        </ControlBar>
      }
    >
      {statusBanners}
      <PreviewWindow
        client={client}
        inviteToken={token}
        composerTemplateUrl={props.config?.composerTemplateUrl}
      />
    </StageShell>
  );
}
