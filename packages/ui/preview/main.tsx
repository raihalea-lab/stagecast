import React from "react";
import { createRoot } from "react-dom/client";
import { AlertCircle, Camera, Mic, MicOff, ScreenShare, Settings, Users } from "lucide-react";
import {
  AppShell,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ControlBar,
  DeviceMeter,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  EgressControl,
  EmptyState,
  EventListItem,
  Input,
  Label,
  LayoutPicker,
  LifecycleControl,
  LiveStats,
  LiveTensionBar,
  MonoNumber,
  OpenStageButton,
  ParticipantList,
  ParticipantTile,
  ReconnectingBanner,
  RoleSwitcher,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  Skeleton,
  StageShell,
  StatusPill,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TallyIndicator,
  ThemeToggle,
  Toaster,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  toast,
  type ParticipantInfo,
  type StageRole,
  type ThemeMode,
} from "../src/index.js";
import type { LayoutKind } from "@stagecast/shared";
import "../src/styles.css";

const fakeParticipants: ParticipantInfo[] = [
  {
    identity: "speaker-001",
    name: "山田 太郎",
    role: "speaker",
    isTalking: true,
    isMuted: false,
    isScreenSharing: false,
  },
  {
    identity: "speaker-002",
    name: "鈴木 花子",
    role: "speaker",
    isTalking: false,
    isMuted: false,
    isScreenSharing: true,
  },
  {
    identity: "mod-001",
    name: "佐藤 進行",
    role: "moderator",
    isTalking: false,
    isMuted: true,
    isScreenSharing: false,
  },
];

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-b border-line-1 px-6 py-6">
      <header className="flex flex-col gap-0.5">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-text-tertiary">
          {title}
        </h2>
        {description && <p className="text-xs text-text-secondary">{description}</p>}
      </header>
      <div className="flex flex-wrap items-start gap-4">{children}</div>
    </section>
  );
}

function PreviewApp() {
  const [theme, setTheme] = React.useState<ThemeMode>("dark");
  const [layout, setLayout] = React.useState<LayoutKind>("grid");
  const [role, setRole] = React.useState<StageRole>("admin");
  const [level, setLevel] = React.useState(0.4);
  const [focus, setFocus] = React.useState<string | undefined>("speaker-002");

  React.useEffect(() => {
    const id = setInterval(() => {
      setLevel(Math.random() * 0.9);
    }, 600);
    return () => clearInterval(id);
  }, []);

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme === "system" ? "dark" : theme;
  }, [theme]);

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-12 items-center gap-2 border-b border-line-1 px-4">
        <TallyIndicator state="on-air" size="md" />
        <span className="font-mono text-sm font-semibold tracking-wide">STAGECAST</span>
      </div>
      <div className="flex flex-col gap-px py-2">
        <EventListItem
          title="Tech Conf 2026"
          startsAt="2026-07-01T09:00:00+09:00"
          status="live"
          active
        />
        <EventListItem title="Team All-Hands" startsAt="2026-07-05T18:00:00+09:00" status="draft" />
        <EventListItem
          title="Q2 Retrospective"
          startsAt="2026-06-20T15:00:00+09:00"
          status="ended"
        />
      </div>
      <div className="mt-auto flex flex-col gap-2 border-t border-line-1 p-3">
        <ThemeToggle value={theme} onChange={setTheme} />
        <Button variant="ghost" size="sm" className="justify-start gap-2">
          <Settings className="size-4" />
          設定
        </Button>
      </div>
    </div>
  );
  const topBar = (
    <div className="flex h-12 items-center justify-between px-4">
      <div className="flex items-center gap-2 text-xs text-text-secondary">
        <span>Events</span>
        <span className="text-text-tertiary">/</span>
        <span className="text-text-primary">Tech Conf 2026</span>
      </div>
      <div className="flex items-center gap-3">
        <StatusPill variant="live" />
        <Button variant="secondary" size="sm">
          ログアウト
        </Button>
      </div>
    </div>
  );

  return (
    <TooltipProvider delayDuration={200}>
      <AppShell sidebar={sidebar} topBar={topBar}>
        <div className="mx-auto max-w-5xl">
          <Section title="Tally / Status" description="放送機材のメタファー一式">
            <TallyIndicator state="idle" size="sm" />
            <TallyIndicator state="idle" size="md" />
            <TallyIndicator state="idle" size="lg" />
            <TallyIndicator state="preview" size="lg" />
            <TallyIndicator state="on-air" size="lg" />
            <StatusPill variant="draft" />
            <StatusPill variant="live" />
            <StatusPill variant="ended" />
            <StatusPill variant="ok">設定済み</StatusPill>
            <StatusPill variant="warn">未設定</StatusPill>
            <StatusPill variant="loading">読み込み中…</StatusPill>
          </Section>

          <Section title="Mono Numerics" description="計測値の固定幅表示">
            <MonoNumber value={1280} unit="kbps" width={5} />
            <MonoNumber value={-24} unit="dB" width={3} />
            <MonoNumber value={2840} unit="ms" width={4} tone="warn" />
            <MonoNumber value={9} width={2} tone="primary" align="left" />
            <MonoNumber value={3600} unit="s" width={5} />
          </Section>

          <Section title="Buttons" description="全 variant + size">
            <Button>配信開始</Button>
            <Button variant="secondary">下書き保存</Button>
            <Button variant="outline">キャンセル</Button>
            <Button variant="ghost">編集</Button>
            <Button variant="destructive">配信終了</Button>
            <Button variant="link">詳細</Button>
            <Button size="sm">SM</Button>
            <Button size="lg">LG</Button>
            <Button size="icon" aria-label="マイク">
              <Mic />
            </Button>
            <Button disabled>無効</Button>
          </Section>

          <Section title="Inputs / Forms">
            <div className="flex w-72 flex-col gap-2">
              <Label htmlFor="title">イベント名</Label>
              <Input id="title" placeholder="Tech Conf 2026" />
            </div>
            <div className="flex w-72 flex-col gap-2">
              <Label>字幕言語</Label>
              <Select defaultValue="ja">
                <SelectTrigger>
                  <SelectValue placeholder="選択" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ja">日本語</SelectItem>
                  <SelectItem value="en">English</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </Section>

          <Section title="Tabs / Sheet / Dialog">
            <Tabs defaultValue="setup" className="w-80">
              <TabsList>
                <TabsTrigger value="setup">Setup</TabsTrigger>
                <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
              </TabsList>
              <TabsContent value="setup">
                <p className="text-sm text-text-secondary">素材 / 招待 URL / 出力先設定</p>
              </TabsContent>
              <TabsContent value="artifacts">
                <p className="text-sm text-text-secondary">録画 / 確定字幕</p>
              </TabsContent>
            </Tabs>
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="secondary">新規イベント</Button>
              </SheetTrigger>
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>新規イベントを作成</SheetTitle>
                  <SheetDescription>タイトルと開始時刻を入力してください</SheetDescription>
                </SheetHeader>
                <div className="mt-4 flex flex-col gap-3">
                  <Input placeholder="タイトル" />
                </div>
              </SheetContent>
            </Sheet>
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline">確認 dialog</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>準備完了です</DialogTitle>
                  <DialogDescription>LiveKit room の準備が完了しました</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button onClick={() => toast("配信を開始しました")}>OK</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="情報">
                  <AlertCircle />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Tooltip テキスト</TooltipContent>
            </Tooltip>
          </Section>

          <Section title="Skeleton / Separator / Empty">
            <div className="flex w-72 flex-col gap-2">
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-1/2" />
            </div>
            <Separator orientation="vertical" className="h-16" />
            <EmptyState
              title="まだ録画はありません"
              description="配信終了後に S3 に保存されます"
              icon={<Users />}
              className="w-72"
            />
          </Section>

          <Section title="DeviceMeter" description="マイク音量メーター (横/縦)">
            <DeviceMeter level={level} showDb size="lg" className="w-72" />
            <DeviceMeter level={level} orientation="v" showDb size="md" className="h-24" />
          </Section>

          <Section title="LayoutPicker" description="←→ / 1〜4 で切替可">
            <LayoutPicker value={layout} onChange={setLayout} />
            <span className="font-mono text-xs text-text-tertiary">現在: {layout}</span>
          </Section>

          <Section title="ParticipantList">
            <ParticipantList
              className="w-96"
              participants={fakeParticipants}
              focusIdentity={focus}
              onFocus={(id) => setFocus(id === focus ? undefined : id)}
              onRequestMute={(id) => {
                toast(`ミュート要請: ${id}`);
              }}
            />
          </Section>

          <Section title="LifecycleControl / EgressControl / LiveStats">
            <LifecycleControl
              className="w-80"
              state="running"
              elapsedSec={1842}
              participantCount={9}
              onEnd={() => {
                toast("配信終了");
              }}
            />
            <EgressControl
              className="w-80"
              state="active"
              targets={[
                { kind: "youtube", label: "Tech Conf channel" },
                { kind: "s3", label: "録画 (event-2026-07)" },
              ]}
              rtmpUrl="rtmp://a.rtmp.youtube.com/live2"
              onStart={() => {
                toast("Egress 開始");
              }}
              onStop={() => {
                toast("Egress 停止");
              }}
            />
            <LiveStats
              className="w-80"
              stats={{
                bitrateKbps: 4280,
                droppedFrames: 0,
                captionLagMs: 2840,
                participantCount: 9,
                elapsedSec: 1842,
              }}
            />
          </Section>

          <Section title="RoleSwitcher / OpenStageButton / ReconnectingBanner">
            <RoleSwitcher value={role} onChange={setRole} experimental />
            <OpenStageButton
              eventId="evt-001"
              fetcher={async () => ({
                token: "preview-token",
                livekitUrl: "wss://preview.local",
                expiresAt: Date.now() + 3600_000,
                stageUrl: "/preview-stage",
              })}
            />
            <ReconnectingBanner kind="reconnecting" className="w-96" />
            <ReconnectingBanner
              kind="retry-progress"
              attempt={4}
              nextWaitSec={5}
              elapsedSec={42}
              maxSec={60}
              className="w-96"
            />
          </Section>

          <Section title="ControlBar (stage-web 用)" description="sticky bottom">
            <div className="w-full overflow-hidden rounded-md border border-line-1">
              <div className="h-32 bg-surface-2" />
              <ControlBar>
                <Button size="icon" aria-label="マイク">
                  <Mic />
                </Button>
                <Button size="icon" variant="secondary" aria-label="マイク OFF">
                  <MicOff />
                </Button>
                <Button size="icon" variant="secondary" aria-label="カメラ">
                  <Camera />
                </Button>
                <Button size="icon" variant="secondary" aria-label="画面共有">
                  <ScreenShare />
                </Button>
                <DeviceMeter level={level} showDb className="w-40" />
                <div className="ml-auto flex items-center gap-2">
                  <Button variant="ghost" size="sm">
                    ◀
                  </Button>
                  <MonoNumber value="3 / 12" width={5} align="left" />
                  <Button variant="ghost" size="sm">
                    ▶
                  </Button>
                  <Button variant="destructive" size="sm">
                    退出
                  </Button>
                </div>
              </ControlBar>
            </div>
          </Section>

          <Section
            title="ParticipantTile (composer-template 用)"
            description="lower third + Tally + screen_share 枠"
          >
            <ParticipantTile
              identity="speaker-001"
              name="山田 太郎"
              role="speaker"
              isTalking
              isScreenShare={false}
              className="aspect-video w-72"
            >
              <div className="size-full bg-gradient-to-br from-surface-3 to-surface-1" />
            </ParticipantTile>
            <ParticipantTile
              identity="speaker-002"
              name="鈴木 花子 の画面"
              role="speaker"
              isTalking={false}
              isScreenShare
              className="aspect-video w-72"
            >
              <div className="size-full bg-gradient-to-tr from-surface-4 to-surface-2" />
            </ParticipantTile>
          </Section>

          <Section title="Cards (admin 用)" description="SettingsPage 等で使う">
            <Card className="w-80">
              <CardHeader>
                <CardTitle>YouTube 出力先</CardTitle>
                <CardDescription>RTMP URL とストリームキー</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-text-secondary">
                  ストリームキーは Secrets Manager に保管されます
                </p>
              </CardContent>
            </Card>
          </Section>
        </div>
      </AppShell>

      <StageShellPreview tension="live" />

      <Toaster />
    </TooltipProvider>
  );
}

function StageShellPreview({
  tension,
}: {
  tension: React.ComponentProps<typeof LiveTensionBar>["state"];
}) {
  return (
    <div className="border-t-2 border-tally-500/30 bg-surface-0">
      <p className="px-6 pt-4 font-mono text-[11px] uppercase tracking-wider text-text-tertiary">
        StageShell preview ({tension})
      </p>
      <StageShell
        tension={tension}
        header={
          <div className="flex w-full items-center justify-between">
            <div className="flex items-center gap-3">
              <TallyIndicator state="on-air" size="md" />
              <span className="text-sm font-medium">Tech Conf 2026</span>
              <span className="font-mono text-xs text-text-tertiary">identity: speaker-001</span>
            </div>
            <StatusPill variant="live" />
          </div>
        }
        controlBar={
          <ControlBar>
            <Button size="icon" aria-label="マイク">
              <Mic />
            </Button>
            <Button size="icon" variant="secondary" aria-label="カメラ">
              <Camera />
            </Button>
            <Button size="icon" variant="secondary" aria-label="画面共有">
              <ScreenShare />
            </Button>
            <DeviceMeter level={0.6} showDb className="w-40" />
            <Button variant="destructive" size="sm" className="ml-auto">
              退出
            </Button>
          </ControlBar>
        }
      >
        <div className="mx-auto aspect-video w-full max-w-2xl rounded-md border border-line-2 bg-surface-2" />
      </StageShell>
    </div>
  );
}

createRoot(document.querySelector("#root") as HTMLElement).render(
  <React.StrictMode>
    <PreviewApp />
  </React.StrictMode>,
);
