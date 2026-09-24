import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes, useNavigate, useParams, useLocation } from "react-router-dom";
import type { EventDefinition, EventRequest, EventStatus } from "@stagecast/shared";
import type { CreateEventInput } from "@stagecast/control-api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AppShell,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  EventListItem,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  Skeleton,
  StatusPill,
  TallyIndicator,
  ThemeToggle,
  Toaster,
  TooltipProvider,
  Alert,
  type ThemeMode,
} from "@stagecast/ui";
import {
  ArrowDownUp,
  Calendar,
  Check,
  ExternalLink,
  Image,
  Inbox,
  LogOut,
  Plus,
  Settings,
  Trash2,
  Users,
  X,
} from "@stagecast/ui/icons";
import { HttpControlApiClient } from "./api/http-client.js";
import { HttpAssetService } from "./api/http-asset-service.js";
import { HttpArtifactService } from "./api/http-artifact-service.js";
import type { ControlApiClient, AssetService, ArtifactService } from "./api/types.js";
import { CalendarView } from "./components/CalendarView.js";
import { EventForm } from "./components/EventForm.js";
import { toFormValues, type EventFormValues } from "./lib/event-form.js";
import { EventDetail } from "./components/EventDetail.js";
import { EventRequestList } from "./components/EventRequestList.js";
import { AssetLibrary } from "./components/AssetLibrary.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { CognitoAuthClient, cognitoConfig } from "./auth/cognito.js";
import type { RuntimeConfig } from "./config.js";
import { HttpMaterialsService, type MaterialsService } from "./api/materials-service.js";
import { toErrorMessage } from "./lib/errors.js";

interface AuthState {
  status: "loading" | "anonymous" | "authenticated";
  error?: string;
}

function readInitialTheme(): ThemeMode {
  try {
    const t = localStorage.getItem("stagecast.theme");
    if (t === "light" || t === "dark" || t === "system") return t;
  } catch {
    // localStorage unavailable
  }
  return "dark";
}

function applyTheme(mode: ThemeMode) {
  const root = document.documentElement;
  const resolved =
    mode === "system"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : mode;
  root.dataset.theme = resolved;
  try {
    localStorage.setItem("stagecast.theme", mode);
  } catch {
    // localStorage unavailable
  }
}

export function App(props: {
  config?: RuntimeConfig;
  client?: ControlApiClient;
  assets?: AssetService;
  artifacts?: ArtifactService;
  materials?: MaterialsService;
}) {
  const apiBaseUrl = props.config?.controlApiUrl ?? "";
  const cognito = props.config?.cognito;
  const authClient = useMemo(
    () => (cognito ? new CognitoAuthClient(cognitoConfig(cognito)) : undefined),
    [cognito],
  );
  // Cognito 使用時は期限前に refresh token で更新する (D11)。Cognito 無効時 (ローカル等) は素読み。
  // ログイン画面へ倒すのは "expired" (refresh token が無い/失効した) のときだけ。通信断で更新に
  // 失敗しただけならセッションは生きているので、401 エラーを見せて次の操作で復帰させる。
  const getIdToken = useCallback(async (): Promise<string | undefined> => {
    if (!authClient) return sessionStorage.getItem("stagecast.idToken") ?? undefined;
    const result = await authClient.getValidToken();
    if (result.status === "ok") return result.tokens.idToken;
    if (result.status === "expired") setAuth({ status: "anonymous" });
    return undefined;
  }, [authClient]);

  const client = useMemo(
    () => props.client ?? new HttpControlApiClient(apiBaseUrl, getIdToken),
    [props.client, apiBaseUrl, getIdToken],
  );
  const assets = useMemo(
    () => props.assets ?? new HttpAssetService(apiBaseUrl, getIdToken),
    [props.assets, apiBaseUrl, getIdToken],
  );
  const artifacts = useMemo(
    () => props.artifacts ?? new HttpArtifactService(apiBaseUrl, getIdToken),
    [props.artifacts, apiBaseUrl, getIdToken],
  );
  // ADR 0021: 翻訳参考資料の登録。
  const materials = useMemo(
    () => props.materials ?? new HttpMaterialsService(apiBaseUrl, getIdToken),
    [props.materials, apiBaseUrl, getIdToken],
  );

  const navigate = useNavigate();
  const location = useLocation();
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [events, setEvents] = useState<EventDefinition[]>([]);
  const [eventRequests, setEventRequests] = useState<EventRequest[]>([]);
  const [eventsLoaded, setEventsLoaded] = useState(false);
  const [apiError, setApiError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(readInitialTheme);
  const [statusFilter, setStatusFilter] = useState<EventStatus | "all">("all");
  const [sortNewestFirst, setSortNewestFirst] = useState(true);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  // 新規フォームへの流し込み (カレンダーの日時クリック / イベントの複製)。
  // key を一緒に持つのは、同じ値でもう一度開いたときにフォームを作り直すため。
  const [prefill, setPrefill] = useState<{
    key: number;
    startsAt?: string;
    values?: EventFormValues;
  }>({ key: 0 });
  const openCreateSheet = (p: { startsAt?: string; values?: EventFormValues } = {}) => {
    setPrefill((prev) => ({ key: prev.key + 1, ...p }));
    setSheetOpen(true);
  };

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setApiError(undefined);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setApiError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (!authClient) {
          if (!cancelled) setAuth({ status: "authenticated" });
          return;
        }
        const url = new URL(window.location.href);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (code && state) {
          await authClient.exchangeCode(code, state);
          window.history.replaceState({}, "", "/events");
          if (!cancelled) setAuth({ status: "authenticated" });
          return;
        }
        // 期限切れでも refresh token が生きていればログインし直さずに復帰できる (D11)。
        // 更新できなかった理由が一時的なものなら、ログイン画面に落とさず復帰に賭ける。
        if ((await authClient.getValidToken()).status !== "expired") {
          if (!cancelled) setAuth({ status: "authenticated" });
          return;
        }
        if (!cancelled) setAuth({ status: "anonymous" });
      } catch (err) {
        if (!cancelled) setAuth({ status: "anonymous", error: String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authClient]);

  // 放置中も期限前に更新しておく (D11)。API 呼び出し時にも更新は走るが、そちらは待ち時間になる。
  // タイマーはタブ非アクティブ時に絞られるため、期限そのものの判定は getValidToken 側に任せる。
  useEffect(() => {
    if (!authClient || auth.status !== "authenticated") return;
    const timer = setInterval(() => {
      void authClient.getValidToken().then((result) => {
        if (result.status === "expired") setAuth({ status: "anonymous" });
      });
    }, 60_000);
    return () => clearInterval(timer);
  }, [authClient, auth.status]);

  const refresh = useCallback(async () => {
    const [list, reqs] = await Promise.all([
      client.listEvents(),
      client.listEventRequests().catch(() => [] as EventRequest[]),
    ]);
    setEvents(list);
    setEventRequests(reqs);
    setEventsLoaded(true);
  }, [client]);

  useEffect(() => {
    if (auth.status === "authenticated") void run(refresh);
  }, [auth.status, refresh, run]);

  const create = (input: CreateEventInput) =>
    run(async () => {
      const created = await client.createEvent(input);
      await refresh();
      setSheetOpen(false);
      navigate(`/events/${created.id}`);
    });

  const filteredEvents = useMemo(() => {
    let list = statusFilter === "all" ? events : events.filter((e) => e.status === statusFilter);
    list = [...list].sort((a, b) => {
      const diff = Date.parse(a.startsAt) - Date.parse(b.startsAt);
      return sortNewestFirst ? -diff : diff;
    });
    return list;
  }, [events, statusFilter, sortNewestFirst]);

  const deleteEvent = (id: string) =>
    run(async () => {
      await client.deleteEvent(id);
      await refresh();
      navigate("/events");
    });

  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectableIds = useMemo(
    () => new Set(filteredEvents.filter((e) => e.status !== "live").map((e) => e.id)),
    [filteredEvents],
  );

  const toggleSelectAll = () => {
    const allSelected = [...selectableIds].every((id) => selectedIds.has(id));
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectableIds));
    }
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const bulkDelete = () =>
    run(async () => {
      const ids = [...selectedIds];
      for (const id of ids) {
        await client.deleteEvent(id);
      }
      await refresh();
      exitSelectMode();
      setBulkDeleteOpen(false);
      navigate("/events");
    });

  const login = async () => {
    if (!authClient) return;
    window.location.assign(await authClient.buildLoginUrl());
  };
  const logout = () => {
    if (!authClient) return;
    authClient.clearTokens();
    window.location.assign(authClient.buildLogoutUrl());
  };

  if (auth.status === "loading") {
    return (
      <div className="grid min-h-dvh place-items-center bg-surface-0 p-6">
        <Card className="w-80">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TallyIndicator state="idle" />
              Stagecast
            </CardTitle>
            <CardDescription>読み込み中…</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-1/2" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (auth.status === "anonymous") {
    return (
      <div className="grid min-h-dvh place-items-center bg-surface-0 p-6">
        <Card className="w-96">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 font-mono text-sm tracking-wider">
              <TallyIndicator state="on-air" />
              STAGECAST
            </CardTitle>
            <CardDescription>管理コンソール</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-text-secondary">
              ログインが必要です。 Cognito でサインインしてください。
            </p>
            {auth.error && <Alert>{auth.error}</Alert>}
            <Button onClick={login}>Cognito でログイン</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isSettingsView = location.pathname === "/settings";
  const isCalendarView = location.pathname === "/calendar";
  const isRequestsView = location.pathname === "/event-requests";
  const isLibraryView = location.pathname === "/library";
  const selectedId = location.pathname.match(/^\/events\/(.+)/)?.[1];
  const selected = events.find((e) => e.id === selectedId);
  const pendingRequestCount = eventRequests.filter((r) => r.status === "pending").length;

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-12 items-center gap-2 border-b border-line-1 px-4">
        <TallyIndicator state="on-air" />
        <span className="font-mono text-sm font-semibold tracking-wide text-text-primary">
          STAGECAST
        </span>
      </div>
      <div className="border-b border-line-1 px-3 py-3">
        <Sheet
          open={sheetOpen}
          onOpenChange={(open) => {
            setSheetOpen(open);
          }}
        >
          <Button
            variant="outline"
            className="w-full justify-start gap-2"
            onClick={() => openCreateSheet()}
          >
            <Plus className="size-4" />
            新規イベント
          </Button>
          <SheetContent side="right">
            <SheetHeader>
              <SheetTitle>新規イベント</SheetTitle>
              <SheetDescription>配信イベントを作成します</SheetDescription>
            </SheetHeader>
            <div className="mt-6">
              <EventForm
                key={prefill.key}
                onCreate={create}
                busy={busy}
                initialStartsAt={prefill.startsAt}
                initialValues={prefill.values}
              />
            </div>
          </SheetContent>
        </Sheet>
      </div>
      <div className="flex gap-1 border-b border-line-1 px-3 py-2">
        <button
          type="button"
          onClick={() => navigate("/events")}
          className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
            !isCalendarView && !isRequestsView && !isSettingsView && !isLibraryView
              ? "bg-surface-2 text-text-primary"
              : "text-text-secondary hover:bg-surface-2"
          }`}
        >
          一覧
        </button>
        <button
          type="button"
          onClick={() => navigate("/calendar")}
          className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
            isCalendarView
              ? "bg-surface-2 text-text-primary"
              : "text-text-secondary hover:bg-surface-2"
          }`}
        >
          <Calendar className="size-3" />
          カレンダー
        </button>
      </div>
      <nav className="flex min-h-0 flex-1 flex-col overflow-hidden py-2">
        <div className="flex items-center justify-between px-3 pb-1">
          {selectMode ? (
            <>
              <button
                type="button"
                onClick={toggleSelectAll}
                className="text-[10px] font-medium text-text-secondary hover:text-text-primary"
              >
                {[...selectableIds].every((id) => selectedIds.has(id)) ? "全解除" : "全選択"}
              </button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="選択モードを終了"
                onClick={exitSelectMode}
              >
                <X className="size-3.5" />
              </Button>
            </>
          ) : (
            <>
              <span className="text-[10px] uppercase tracking-wider text-text-tertiary">
                イベント
              </span>
              <div className="flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="選択モード"
                  onClick={() => setSelectMode(true)}
                  title="複数選択"
                  disabled={!eventsLoaded || events.length === 0}
                >
                  <Check className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={sortNewestFirst ? "古い順にする" : "新しい順にする"}
                  onClick={() => setSortNewestFirst((v) => !v)}
                  title={sortNewestFirst ? "新しい順" : "古い順"}
                >
                  <ArrowDownUp className="size-3.5" />
                </Button>
              </div>
            </>
          )}
        </div>
        <div className="flex gap-1 px-3 pb-2">
          {(["all", "draft", "scheduled", "warmup", "live", "ended"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
                statusFilter === s
                  ? "bg-text-primary text-surface-0"
                  : "bg-surface-2 text-text-secondary hover:bg-surface-3"
              }`}
            >
              {s === "all"
                ? "すべて"
                : s === "draft"
                  ? "下書き"
                  : s === "scheduled"
                    ? "予定"
                    : s === "warmup"
                      ? "準備中"
                      : s === "live"
                        ? "配信中"
                        : "終了"}
            </button>
          ))}
        </div>
        {!eventsLoaded ? (
          <ul aria-busy="true" aria-label="読み込み中" className="space-y-1 px-3">
            {[0, 1, 2].map((i) => (
              <li key={i}>
                <Skeleton className="h-9 w-full" />
              </li>
            ))}
          </ul>
        ) : filteredEvents.length === 0 ? (
          <div className="px-3">
            <EmptyState
              title={events.length === 0 ? "まだイベントがありません" : "該当なし"}
              description={
                events.length === 0
                  ? "上のボタンから作成"
                  : "フィルタ条件に一致するイベントがありません"
              }
              icon={<Users />}
            />
          </div>
        ) : (
          <ul className="overflow-auto">
            {filteredEvents.map((e) => (
              <li key={e.id}>
                <EventListItem
                  title={e.title}
                  startsAt={e.startsAt}
                  status={e.status}
                  active={!selectMode && e.id === selectedId}
                  selectable={selectMode}
                  selected={selectedIds.has(e.id)}
                  onClick={
                    selectMode
                      ? () => e.status !== "live" && toggleSelect(e.id)
                      : () => navigate(`/events/${e.id}`)
                  }
                  disabled={selectMode && e.status === "live"}
                />
              </li>
            ))}
          </ul>
        )}
        {selectMode && selectedIds.size > 0 && (
          <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
            <div className="flex items-center gap-2 border-t border-line-1 px-3 py-2">
              <span className="flex-1 text-xs text-text-secondary">{selectedIds.size}件選択中</span>
              <Button
                variant="destructive"
                size="sm"
                className="gap-1.5"
                onClick={() => setBulkDeleteOpen(true)}
                disabled={busy}
              >
                <Trash2 className="size-3.5" />
                削除
              </Button>
            </div>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{selectedIds.size}件のイベントを削除しますか？</AlertDialogTitle>
                <AlertDialogDescription>
                  選択されたイベントと関連するアセット・録画・字幕ファイルがすべて削除されます。この操作は取り消せません。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>キャンセル</AlertDialogCancel>
                <AlertDialogAction onClick={bulkDelete}>
                  {selectedIds.size}件を削除する
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </nav>
      <div className="mt-auto flex flex-col gap-2 border-t border-line-1 p-3">
        <Button
          variant={isLibraryView ? "secondary" : "ghost"}
          size="sm"
          onClick={() => navigate("/library")}
          className="justify-start gap-2"
        >
          <Image className="size-4" />
          アセットライブラリ
        </Button>
        <Button
          variant={isRequestsView ? "secondary" : "ghost"}
          size="sm"
          onClick={() => navigate("/event-requests")}
          className="justify-start gap-2"
        >
          <Inbox className="size-4" />
          リクエスト管理
          {pendingRequestCount > 0 && (
            <span className="ml-auto rounded-full bg-warning px-1.5 py-0.5 text-[10px] font-bold text-white">
              {pendingRequestCount}
            </span>
          )}
        </Button>
        {props.config?.requestWebUrl && (
          <a
            href={props.config.requestWebUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-2 hover:text-text-primary"
          >
            <ExternalLink className="size-4" />
            リクエストカレンダー
          </a>
        )}
        <Button
          variant={isSettingsView ? "secondary" : "ghost"}
          size="sm"
          onClick={() => navigate("/settings")}
          className="justify-start gap-2"
        >
          <Settings className="size-4" />
          運用設定
        </Button>
        <div className="flex items-center justify-between">
          <ThemeToggle value={theme} onChange={setTheme} />
          {authClient && (
            <Button variant="ghost" size="icon-sm" aria-label="ログアウト" onClick={logout}>
              <LogOut />
            </Button>
          )}
        </div>
      </div>
    </div>
  );

  const topBar = (
    <div className="flex h-12 items-center justify-between px-5">
      <div className="flex items-center gap-2 text-xs text-text-secondary">
        <span>
          {isSettingsView
            ? "運用設定"
            : isLibraryView
              ? "アセットライブラリ"
              : isCalendarView
                ? "カレンダー"
                : isRequestsView
                  ? "リクエスト管理"
                  : "イベント"}
        </span>
        {!isSettingsView && selected && (
          <>
            <span className="text-text-tertiary">/</span>
            <span className="text-text-primary">{selected.title}</span>
          </>
        )}
      </div>
      <div className="flex items-center gap-3">
        {!isSettingsView && selected && (
          <StatusPill
            variant={
              selected.status === "scheduled"
                ? "scheduled"
                : selected.status === "warmup"
                  ? "warmup"
                  : selected.status === "live"
                    ? "live"
                    : selected.status === "ended"
                      ? "ended"
                      : "draft"
            }
          />
        )}
        {busy && (
          <span className="text-xs text-text-tertiary" aria-live="polite">
            処理中…
          </span>
        )}
      </div>
    </div>
  );

  return (
    <TooltipProvider delayDuration={200}>
      <AppShell sidebar={sidebar} topBar={topBar}>
        <div className="mx-auto max-w-5xl px-6 py-6">
          {apiError && (
            <Alert className="mb-4" onDismiss={() => setApiError(undefined)}>
              {apiError}
            </Alert>
          )}
          <Routes>
            <Route path="/" element={<Navigate to="/events" replace />} />
            <Route
              path="/events"
              element={
                <EmptyState
                  title="イベントを選択してください"
                  description="左のサイドバーから選ぶか、新規作成"
                  icon={<Users />}
                />
              }
            />
            <Route
              path="/events/:id"
              element={
                <EventDetailRoute
                  events={events}
                  client={client}
                  assets={assets}
                  artifacts={artifacts}
                  materials={materials}
                  onChanged={() => void run(refresh)}
                  onDelete={deleteEvent}
                  onCopy={(e) => openCreateSheet({ values: toFormValues(e) })}
                />
              }
            />
            <Route
              path="/calendar"
              element={
                <CalendarView
                  events={events}
                  requests={eventRequests}
                  onEventClick={(id) => navigate(`/events/${id}`)}
                  onDateTimeClick={(dateTime) => openCreateSheet({ startsAt: dateTime })}
                />
              }
            />
            <Route
              path="/event-requests"
              element={
                <EventRequestList
                  client={client}
                  onApproved={(eventId) => {
                    void run(refresh);
                    navigate(`/events/${eventId}`);
                  }}
                />
              }
            />
            <Route path="/library" element={<AssetLibrary client={client} assets={assets} />} />
            <Route path="/settings" element={<SettingsPage client={client} />} />
            <Route path="*" element={<Navigate to="/events" replace />} />
          </Routes>
        </div>
      </AppShell>
      <Toaster />
    </TooltipProvider>
  );
}

function EventDetailRoute(props: {
  events: EventDefinition[];
  client: ControlApiClient;
  assets: AssetService;
  artifacts: ArtifactService;
  materials: MaterialsService;
  onChanged: () => void;
  onDelete: (id: string) => void;
  onCopy: (event: EventDefinition) => void;
}) {
  const { id } = useParams<{ id: string }>();
  const event = props.events.find((e) => e.id === id);

  if (!event) {
    return (
      <EmptyState
        title="イベントが見つかりません"
        description="サイドバーから別のイベントを選んでください"
        icon={<Users />}
      />
    );
  }

  return (
    <EventDetail
      event={event}
      client={props.client}
      assets={props.assets}
      artifacts={props.artifacts}
      materials={props.materials}
      onChanged={props.onChanged}
      onDelete={props.onDelete}
      onCopy={props.onCopy}
    />
  );
}
