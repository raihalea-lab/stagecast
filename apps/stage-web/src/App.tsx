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
import { decodeStageMessage, type LayoutKind, type StageRole } from "@stagecast/shared";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ControlBar,
  EgressControl,
  Input,
  Label,
  LayoutPicker,
  LifecycleControl,
  LiveStats,
  ParticipantList,
  ReconnectingBanner,
  RoleSwitcher,
  StageShell,
  StatusPill,
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
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
} from "@stagecast/ui/icons";

function toParticipantInfo(s: ParticipantSnapshot): ParticipantInfo {
  const role = s.identity.startsWith("speaker-")
    ? ("speaker" as const)
    : s.identity.startsWith("moderator-")
      ? ("moderator" as const)
      : s.identity.startsWith("admin-")
        ? ("admin" as const)
        : undefined;
  return { ...s, role };
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
  const [muteNotice, setMuteNotice] = useState<string | undefined>();
  const [roomState, setRoomState] = useState<RoomState>("stopped");
  const [egressState, setEgressState] = useState<EgressState>("idle");
  const [elapsedSec, setElapsedSec] = useState(0);
  const elapsedRef = useRef<ReturnType<typeof setInterval>>(undefined);

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
    controller.onParticipantsChanged(setParticipants);
    controller.onDataReceived((payload) => {
      const msg = decodeStageMessage(payload);
      if (!msg) return;
      if (msg.type === "mute-request") {
        setMuteNotice("モデレーターからミュート要請がありました");
        setTimeout(() => setMuteNotice(undefined), 5000);
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
    } finally {
      setBusy(false);
      setRetryInfo(undefined);
    }
  };

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

  // --- 未入室画面 ---
  if (!session) {
    // Admin 自動接続中のローディング表示
    if (adminDirect) {
      return (
        <StageShell tension={tension}>
          <div className="mx-auto w-full max-w-md space-y-6 pt-8 text-center">
            <h1 className="text-2xl font-bold tracking-tight text-text-primary">
              管理者として接続中…
            </h1>
            {error && (
              <div
                role="alert"
                className="flex items-start gap-3 rounded-md border border-error/40 bg-error/10 px-4 py-3 text-sm text-error"
              >
                <span className="flex-1">{error}</span>
              </div>
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

  const slideControls = (
    <>
      <div className="mx-1 h-6 w-px bg-line-1" aria-hidden />
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={busy}
          onClick={wrap(async () => setPage(await controller.slidePrev()))}
          aria-label="前のスライド"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span className="min-w-[3ch] text-center font-mono text-xs tabular-nums text-text-secondary">
          {page}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={busy}
          onClick={wrap(async () => setPage(await controller.slideNext()))}
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
          }}
          disabled={busy}
        />
      </CardContent>
    </Card>
  );

  const participantList = (
    <ParticipantList
      participants={participants.map(toParticipantInfo)}
      focusIdentity={focusIdentity}
      onFocus={(identity) => {
        const next = identity === focusIdentity ? undefined : identity;
        setFocusIdentity(next);
        void controller.changeLayout(layout, next);
      }}
      onRequestMute={(identity) => {
        void controller.requestMute(identity);
      }}
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
        <div className="flex gap-4">
          <div className="min-w-0 flex-1 space-y-4">
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
          <aside className="w-[360px] shrink-0 space-y-4">
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
            {layoutPicker}
            {participantList}
            <LiveStats stats={stats} />
          </aside>
        </div>
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
            {slideControls}
            <div className="flex-1" />
            {leaveButton}
          </ControlBar>
        }
      >
        {statusBanners}
        <div className="flex gap-4">
          <div className="min-w-0 flex-1 space-y-4">
            <PreviewWindow
              client={client}
              inviteToken={token}
              composerTemplateUrl={props.config?.composerTemplateUrl}
            />
          </div>
          <aside className="w-80 shrink-0 space-y-4">
            {layoutPicker}
            {participantList}
          </aside>
        </div>
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
          {slideControls}
          <div className="flex-1" />
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
