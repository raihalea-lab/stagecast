/**
 * stage-web から制御 API を呼ぶクライアント (DESIGN.md 4.1, F-1, ADR 0008 D-3)。
 *
 * 招待トークンを /join に提示し、LiveKit 接続情報を受け取る。認証は招待トークンのみで、
 * 管理者用 Cognito は不要 (モデレーター・登壇者はアカウントを持たない)。
 *
 * EventMediaStack 起動中で per-event URL が確定していない間は制御 API が 503 を返す
 * (ADR 0008 D-3)。本クライアントは自動で exponential backoff してリトライし、最終的に
 * 200 もしくは別エラーが返るのを待つ。UI には onRetry で進捗を伝える。
 */
import type {
  AssetMetadata,
  DeckRef,
  InvitedRole,
  LayoutKind,
  PresentationState,
  Preset,
  SlideSource,
  SpeakerVisibility,
} from "@stagecast/shared";

/**
 * R12-followup-19 / ADR 0011 案 E: TURN/STUN server。
 * AWS KVS WebRTC が短期 credential 付きで返す iceServers。
 * stage-web は `Room.connect` の `rtcConfig.iceServers` に渡すことで LiveKit Client SDK の
 * `if (!rtcConfig.iceServers)` 判定で server からの iceServers を bypass し、 確実に TURN を使う。
 */
export interface JoinIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface JoinSuccess {
  ok: true;
  eventId: string;
  role: InvitedRole;
  room: string;
  identity: string;
  livekitUrl: string;
  livekitToken: string;
  /** R12-followup-19: server-side が KVS から取得した TURN servers。 無ければ SFU 直接 UDP のみ。 */
  iceServers?: JoinIceServer[];
}
export interface JoinFailure {
  ok: false;
  reason: string;
}
export type JoinResponse = JoinSuccess | JoinFailure;

export interface JoinOptions {
  /**
   * 503 を受けたときに自動リトライする最大累積待ち時間 (秒)。0 ならリトライ無効。
   * 既定 60s = reconcile tick (60s) + ECS task 起動 (3〜5 分) の組み合わせを
   * 1 リトライサイクルで吸収する想定。
   */
  maxRetryWaitSec?: number;
  /**
   * リトライ前に呼ばれるコールバック (UI 進捗表示用)。
   * attempt は 1 オリジン、nextWaitSec は次の待機秒数。
   */
  onRetry?: (info: { attempt: number; nextWaitSec: number; elapsedSec: number }) => void;
  /** sleep 実装 (テストでは即時 resolve に差し替え)。 */
  sleep?: (ms: number) => Promise<void>;
}

/** Preview LiveKit Token 発行結果 (R17-Phase3, ADR 0012 D-6)。 */
export interface PreviewTokenResponse {
  livekitUrl: string;
  livekitToken: string;
  identity: string;
  room: string;
}

export interface StageClient {
  join(token: string, displayName?: string, options?: JoinOptions): Promise<JoinResponse>;
  issuePreviewToken(inviteToken: string): Promise<PreviewTokenResponse>;
  setSpeakerVisibility(
    inviteToken: string,
    eventId: string,
    speakerId: string,
    visibility: SpeakerVisibility,
  ): Promise<void>;
  listAssets(inviteToken: string): Promise<AssetMetadata[]>;
  getAssetDownloadUrl(inviteToken: string, assetKey: string): Promise<string>;
  listPresets(inviteToken: string): Promise<Preset[]>;
  createPreset(inviteToken: string, label: string, config: Preset["config"]): Promise<Preset>;
  deletePreset(inviteToken: string, presetId: string): Promise<void>;
  /** 事前アップロードスライド (PDF) のデッキ用アップロード URL を取得する (F-3, 5.2)。 */
  getMaterialUploadUrl(
    inviteToken: string,
    filename: string,
  ): Promise<{
    assetId: string;
    key: string;
    uploadUrl: string;
  }>;
  /** 事前アップロードスライド (PDF) の署名付き GET URL を取得する (F-3, 5.2)。 */
  getMaterialDownloadUrl(inviteToken: string, assetKey: string): Promise<string>;
  /**
   * 投影状態を読む (ADR 0022 D-1)。入室時に呼べば現在のデッキとページが分かる。
   * `deckUrl` は署名付きで、読むたびにサーバーが発行し直す。
   */
  getPresentationState(inviteToken: string): Promise<PresentationSnapshot>;
  /** 投影状態を書く (ADR 0022 D-1)。`slideSource` を省略すると投影解除。 */
  setSlideState(inviteToken: string, update: SlideStateUpdate): Promise<PresentationSnapshot>;
  /** レイアウトを書く (ADR 0025 D-1)。 サーバが room metadata も貼り直す。 */
  setLayoutState(
    inviteToken: string,
    layout: LayoutKind,
    focusIdentity?: string,
  ): Promise<PresentationSnapshot>;
  /** YouTube への送出を開始する (ADR 0026 D-3, moderator のみ)。 */
  startEgress(inviteToken: string): Promise<void>;
  /** YouTube への送出を停止する (ADR 0026 D-3, moderator のみ)。 */
  stopEgress(inviteToken: string): Promise<void>;
}

/** control-api が返す投影状態 (署名付き URL 付き)。 */
export type PresentationSnapshot = PresentationState & { deckUrl?: string };

/** 投影状態の更新内容。 */
export interface SlideStateUpdate {
  slideSource?: SlideSource;
  slidePage?: number;
  deck?: DeckRef;
}

/** ADR 0008 D-3: exponential backoff スケジュール (秒)。 */
const BACKOFF_SCHEDULE_SEC = [1, 2, 4, 8, 16, 30, 30] as const;

export class HttpStageClient implements StageClient {
  constructor(private readonly baseUrl: string) {}

  async join(
    token: string,
    displayName?: string,
    options: JoinOptions = {},
  ): Promise<JoinResponse> {
    const maxRetryWaitSec = options.maxRetryWaitSec ?? 60;
    const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

    let attempt = 0;
    let elapsedSec = 0;
    while (true) {
      attempt++;
      const res = await this.tryOnce(token, displayName);
      if (res.status !== 503) return res.body;
      // 503: リトライ判定
      if (maxRetryWaitSec <= 0) return { ok: false, reason: "media-unavailable" };
      const nextWaitSec =
        BACKOFF_SCHEDULE_SEC[Math.min(attempt - 1, BACKOFF_SCHEDULE_SEC.length - 1)]!;
      // 次の待ちで上限を越えるなら諦める。
      if (elapsedSec + nextWaitSec > maxRetryWaitSec) {
        return { ok: false, reason: "media-unavailable" };
      }
      options.onRetry?.({ attempt, nextWaitSec, elapsedSec });
      await sleep(nextWaitSec * 1000);
      elapsedSec += nextWaitSec;
    }
  }

  /** /join を 1 回だけ呼ぶ (リトライ無し)。Retry-After は将来使うかもしれないので status を返す。 */
  private async tryOnce(
    token: string,
    displayName: string | undefined,
  ): Promise<{ status: number; body: JoinResponse }> {
    const res = await fetch(`${this.baseUrl}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, displayName }),
    });
    if (res.status === 503) {
      return { status: 503, body: { ok: false, reason: "media-unavailable" } };
    }
    return { status: res.status, body: (await res.json()) as JoinResponse };
  }

  /** R17-Phase3: 招待トークンを提示して viewer-role の preview token を取得する。 */
  async issuePreviewToken(inviteToken: string): Promise<PreviewTokenResponse> {
    const res = await fetch(`${this.baseUrl}/preview-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteToken }),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      throw new Error(`preview-token failed (${res.status}): ${msg}`);
    }
    return (await res.json()) as PreviewTokenResponse;
  }

  async setSpeakerVisibility(
    inviteToken: string,
    eventId: string,
    speakerId: string,
    visibility: SpeakerVisibility,
  ): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/presentation/speakers/${encodeURIComponent(speakerId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteToken, eventId, visibility }),
      },
    );
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      throw new Error(`setSpeakerVisibility failed (${res.status}): ${msg}`);
    }
  }

  async listAssets(inviteToken: string): Promise<AssetMetadata[]> {
    const res = await fetch(`${this.baseUrl}/stage/assets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteToken }),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      throw new Error(`listAssets failed (${res.status}): ${msg}`);
    }
    const data = (await res.json()) as { assets: AssetMetadata[] };
    return data.assets;
  }

  async getAssetDownloadUrl(inviteToken: string, assetKey: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/stage/assets/download-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteToken, assetKey }),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      throw new Error(`getAssetDownloadUrl failed (${res.status}): ${msg}`);
    }
    const data = (await res.json()) as { downloadUrl: string };
    return data.downloadUrl;
  }

  async listPresets(inviteToken: string): Promise<Preset[]> {
    const res = await fetch(`${this.baseUrl}/stage/presets/list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteToken }),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      throw new Error(`listPresets failed (${res.status}): ${msg}`);
    }
    const data = (await res.json()) as { presets: Preset[] };
    return data.presets;
  }

  async createPreset(
    inviteToken: string,
    label: string,
    config: Preset["config"],
  ): Promise<Preset> {
    const res = await fetch(`${this.baseUrl}/stage/presets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteToken, label, config }),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      throw new Error(`createPreset failed (${res.status}): ${msg}`);
    }
    const data = (await res.json()) as { preset: Preset };
    return data.preset;
  }

  async deletePreset(inviteToken: string, presetId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/stage/presets/${encodeURIComponent(presetId)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteToken }),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      throw new Error(`deletePreset failed (${res.status}): ${msg}`);
    }
  }

  async getMaterialUploadUrl(
    inviteToken: string,
    filename: string,
  ): Promise<{ assetId: string; key: string; uploadUrl: string }> {
    const res = await fetch(`${this.baseUrl}/stage/materials/upload-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteToken, filename, contentType: "application/pdf" }),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      throw new Error(`getMaterialUploadUrl failed (${res.status}): ${msg}`);
    }
    return (await res.json()) as { assetId: string; key: string; uploadUrl: string };
  }

  async getPresentationState(inviteToken: string): Promise<PresentationSnapshot> {
    return this.postStage("/stage/presentation/state", { inviteToken }, "getPresentationState");
  }

  async setSlideState(
    inviteToken: string,
    update: SlideStateUpdate,
  ): Promise<PresentationSnapshot> {
    return this.postStage("/stage/presentation/slide", { inviteToken, ...update }, "setSlideState");
  }

  async setLayoutState(
    inviteToken: string,
    layout: LayoutKind,
    focusIdentity?: string,
  ): Promise<PresentationSnapshot> {
    return this.postStage(
      "/stage/presentation/layout",
      { inviteToken, layout, focusIdentity },
      "setLayoutState",
    );
  }

  async startEgress(inviteToken: string): Promise<void> {
    await this.postStage("/stage/egress/start", { inviteToken }, "startEgress");
  }

  async stopEgress(inviteToken: string): Promise<void> {
    await this.postStage("/stage/egress/stop", { inviteToken }, "stopEgress");
  }

  private async postStage<T>(path: string, body: unknown, label: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      throw new Error(`${label} failed (${res.status}): ${msg}`);
    }
    return (await res.json()) as T;
  }

  async getMaterialDownloadUrl(inviteToken: string, assetKey: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/stage/materials/download-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteToken, assetKey }),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      throw new Error(`getMaterialDownloadUrl failed (${res.status}): ${msg}`);
    }
    const data = (await res.json()) as { downloadUrl: string };
    return data.downloadUrl;
  }
}
