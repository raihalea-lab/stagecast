import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes, useNavigate, useParams, useLocation } from "react-router-dom";
import type { EventDefinition } from "@stagecast/shared";
import type { CreateEventInput } from "@stagecast/control-api";
import {
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
  type ThemeMode,
} from "@stagecast/ui";
import { LogOut, Plus, Settings, Users } from "@stagecast/ui/icons";
import { HttpControlApiClient } from "./api/http-client.js";
import { HttpAssetService } from "./api/http-asset-service.js";
import { HttpArtifactService } from "./api/http-artifact-service.js";
import type { ControlApiClient, AssetService, ArtifactService } from "./api/types.js";
import { EventForm } from "./components/EventForm.js";
import { EventDetail } from "./components/EventDetail.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { CognitoAuthClient, cognitoConfig } from "./auth/cognito.js";
import type { RuntimeConfig } from "./config.js";
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
}) {
  const apiBaseUrl = props.config?.controlApiUrl ?? "";
  const cognito = props.config?.cognito;
  const authClient = useMemo(
    () => (cognito ? new CognitoAuthClient(cognitoConfig(cognito)) : undefined),
    [cognito],
  );
  const getIdToken = useCallback(
    (): string | undefined =>
      authClient?.getTokens()?.idToken ?? sessionStorage.getItem("stagecast.idToken") ?? undefined,
    [authClient],
  );

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

  const navigate = useNavigate();
  const location = useLocation();
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [events, setEvents] = useState<EventDefinition[]>([]);
  const [eventsLoaded, setEventsLoaded] = useState(false);
  const [apiError, setApiError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(readInitialTheme);

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
        if (authClient.getTokens()) {
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

  const refresh = useCallback(async () => {
    const list = await client.listEvents();
    setEvents(list);
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
            {auth.error && (
              <p
                role="alert"
                className="rounded-md border border-error/40 bg-error/10 px-3 py-2 text-xs text-error"
              >
                {auth.error}
              </p>
            )}
            <Button onClick={login}>Cognito でログイン</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isSettingsView = location.pathname === "/settings";
  const selectedId = location.pathname.match(/^\/events\/(.+)/)?.[1];
  const selected = events.find((e) => e.id === selectedId);

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-12 items-center gap-2 border-b border-line-1 px-4">
        <TallyIndicator state="on-air" />
        <span className="font-mono text-sm font-semibold tracking-wide text-text-primary">
          STAGECAST
        </span>
      </div>
      <div className="border-b border-line-1 px-3 py-3">
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <Button
            variant="outline"
            className="w-full justify-start gap-2"
            onClick={() => setSheetOpen(true)}
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
              <EventForm onCreate={create} busy={busy} />
            </div>
          </SheetContent>
        </Sheet>
      </div>
      <nav className="flex flex-col gap-px overflow-auto py-2">
        <span className="px-3 pb-1 text-[10px] uppercase tracking-wider text-text-tertiary">
          イベント
        </span>
        {!eventsLoaded ? (
          <ul aria-busy="true" aria-label="読み込み中" className="space-y-1 px-3">
            {[0, 1, 2].map((i) => (
              <li key={i}>
                <Skeleton className="h-9 w-full" />
              </li>
            ))}
          </ul>
        ) : events.length === 0 ? (
          <div className="px-3">
            <EmptyState
              title="まだイベントがありません"
              description="上のボタンから作成"
              icon={<Users />}
            />
          </div>
        ) : (
          <ul>
            {events.map((e) => (
              <li key={e.id}>
                <EventListItem
                  title={e.title}
                  startsAt={e.startsAt}
                  status={e.status}
                  active={e.id === selectedId}
                  onClick={() => navigate(`/events/${e.id}`)}
                />
              </li>
            ))}
          </ul>
        )}
      </nav>
      <div className="mt-auto flex flex-col gap-2 border-t border-line-1 p-3">
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
        <span>{isSettingsView ? "運用設定" : "イベント"}</span>
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
              selected.status === "live" ? "live" : selected.status === "ended" ? "ended" : "draft"
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
            <div
              role="alert"
              className="mb-4 flex items-start gap-3 rounded-md border border-error/40 bg-error/10 px-4 py-3 text-sm text-error"
            >
              <span className="flex-1">{apiError}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="エラーを閉じる"
                onClick={() => setApiError(undefined)}
              >
                ×
              </Button>
            </div>
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
                  onChanged={() => void run(refresh)}
                />
              }
            />
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
  onChanged: () => void;
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
      onChanged={props.onChanged}
    />
  );
}
