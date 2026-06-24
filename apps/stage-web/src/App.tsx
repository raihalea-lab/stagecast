/**
 * 登壇者・モデレーター用ステージ画面 (DESIGN.md 4.1, 5.2, F-1, F-3)。
 *
 * D7: StageShell + ControlBar ベースの Speaker サブビュー。
 * D8: Moderator サブビュー (2 カラム: PreviewWindow + ParticipantList + LayoutPicker)。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { HttpStageClient, type StageClient } from "./api/stage-client.js";
import { LiveKitRoomConnector } from "./lib/livekit-room.js";
import { BrowserMediaDevicesProvider } from "./lib/browser-devices.js";
import type { MediaDevicesProvider, PreferredDevices } from "./lib/devices.js";
import type { ParticipantSnapshot, RoomConnector } from "./lib/room.js";
import { StageController, type StageSession } from "./stage-controller.js";
import { parseInviteToken } from "./lib/token.js";
import { DeviceCheck } from "./components/DeviceCheck.js";
import { PreviewWindow } from "./components/PreviewWindow.js";
import type { RuntimeConfig } from "./config.js";
import { decodeStageMessage, type LayoutKind } from "@stagecast/shared";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ControlBar,
  Input,
  Label,
  LayoutPicker,
  ParticipantList,
  ReconnectingBanner,
  StageShell,
  StatusPill,
  type ParticipantInfo,
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
  const [retryInfo, setRetryInfo] = useState<
    { attempt: number; nextWaitSec: number; elapsedSec: number } | undefined
  >();
  const [participants, setParticipants] = useState<ParticipantSnapshot[]>([]);
  const [layout, setLayout] = useState<LayoutKind>("grid");
  const [focusIdentity, setFocusIdentity] = useState<string | undefined>();
  const [muteNotice, setMuteNotice] = useState<string | undefined>();

  useEffect(() => {
    controller.onDisconnected(() => {
      setSession(undefined);
      setReconnecting(false);
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

  if (!session) {
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

  const roleLabel = session.role === "speaker" ? "登壇者" : "モデレーター";
  const isModerator = session.role === "moderator";

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
      onClick={wrap(() => controller.leave().then(() => setSession(undefined)))}
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
        <StatusPill variant="muted" showDot={false} className="text-xs">
          {roleLabel}
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

  if (isModerator) {
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
          </aside>
        </div>
      </StageShell>
    );
  }

  // Speaker サブビュー
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
