/**
 * 制御 API のルーティング層 (フレームワーク非依存)。
 *
 * 正規化した HttpRequest を受け取り HttpResponse を返す。API Gateway 等の
 * トランスポート固有の変換は adapter (index.ts) 側で行う。これにより外部接続なしの
 * 単体テストが容易になる。
 */
import {
  createLogger,
  encodeRoomMetadata,
  materialKey,
  materialsPrefix,
  parseMaterialKey,
} from "@stagecast/shared";
import type {
  AssetMetadata,
  InvitedRole,
  Preset,
  PresentationState,
  SlideSource,
  SpeakerVisibility,
} from "@stagecast/shared";
import type { AdminAuthVerifier, AdminPrincipal } from "../auth/admin-auth.js";
import { UnauthorizedError } from "../auth/admin-auth.js";
import {
  NotFoundError,
  ValidationError,
  type CreateEventInput,
  type EventService,
} from "../usecases/events.js";
import type { createInviteService } from "../usecases/invites.js";
import type { createPresentationService } from "../usecases/presentation.js";
import { ServiceUnavailableError, type createJoinService } from "../usecases/join.js";
import type { createAssetUploadService } from "../assets/asset-upload.js";
import type { createMaterialUploadService } from "../assets/asset-upload.js";
import type { createArtifactDownloadService } from "../assets/artifact-download.js";
import type { AdminTokenService } from "../usecases/admin-token.js";
import type { EgressService } from "../usecases/egress.js";
import type { EventRequestService, CreateEventRequestInput } from "../usecases/event-requests.js";
import type { PreviewTokenService } from "../usecases/preview-token.js";
import type { SettingsService } from "../usecases/settings.js";
import type { ArtifactStore } from "../assets/artifact-download.js";
import type { AssetMetadataRepository, PresetRepository } from "../repo/types.js";

export interface HttpRequest {
  method: string;
  /** パス (例: /events/abc/invites)。 */
  path: string;
  headers: Record<string, string | undefined>;
  body?: unknown;
}
export interface HttpResponse {
  status: number;
  body: unknown;
  /** 追加レスポンスヘッダ (例: 503 で Retry-After を返す, ADR 0008 D-3)。 */
  headers?: Record<string, string>;
}

type InviteService = ReturnType<typeof createInviteService>;
type PresentationService = ReturnType<typeof createPresentationService>;
type JoinService = ReturnType<typeof createJoinService>;
type AssetUploadService = ReturnType<typeof createAssetUploadService>;
type MaterialUploadService = ReturnType<typeof createMaterialUploadService>;
type ArtifactDownloadService = ReturnType<typeof createArtifactDownloadService>;

export interface AppDeps {
  auth: AdminAuthVerifier;
  events: EventService;
  invites: InviteService;
  presentation: PresentationService;
  join: JoinService;
  /** 素材アップロード署名サービス (S3 未設定なら省略され 503)。 */
  assets?: AssetUploadService;
  /** 事前アップロードスライド (PDF) のデッキ用アップロード署名サービス (F-3, 5.2)。 */
  materials?: MaterialUploadService;
  /** 成果物ダウンロードサービス (S3 未設定なら省略され 503)。 */
  artifacts?: ArtifactDownloadService;
  /** 運用設定 (LiveKit / YouTube 認証情報) 管理 (Secrets Manager 未設定なら省略され 503)。 */
  settings?: SettingsService;
  /** Egress (RTMP 送出) 起動サービス (R12)。未設定なら省略され 503。 */
  egress?: EgressService;
  /** Admin LiveKit token 発行 (R16 / ADR 0012 D-4: admin-web layout 切替用)。未設定なら省略され 503。 */
  adminToken?: AdminTokenService;
  /** Preview LiveKit token 発行 (R17 / ADR 0012 D-6: admin-web/stage-web iframe プレビュー用)。未設定なら省略され 503。 */
  previewToken?: PreviewTokenService;
  /** イベントリクエスト (モデレーター向け公開 + 管理者承認)。 */
  eventRequests?: EventRequestService;
  /** アセットメタデータ管理 (Phase 2)。 */
  assetMetadataRepo?: AssetMetadataRepository;
  /** presigned GET URL 生成用 S3 ストア (Phase 3: stage-web アセット参照)。 */
  artifactStore?: ArtifactStore;
  /** 演出プリセット管理 (Phase 4)。 */
  presetRepo?: PresetRepository;
  /**
   * 投影状態を LiveKit の room metadata に載せる (ADR 0022 D-1)。
   * 未設定なら載せない (composer は DataChannel の配り直しに頼る従来動作)。
   */
  roomMetadata?: RoomMetadataPublisher;
  /** UUID 生成器。 */
  newId?: () => string;
  /** 現在時刻 (ISO 8601 生成用)。 */
  now?: () => number;
}

const json = (status: number, body: unknown): HttpResponse => ({ status, body });

/**
 * LiveKit の room metadata を書く。実体は `RoomServiceClient.updateRoomMetadata`。
 * room 名は eventId と一致する。
 */
const log = createLogger({ component: "control-api" });

export interface RoomMetadataPublisher {
  publish(eventId: string, metadata: string): Promise<void>;
}

export function createApp(deps: AppDeps) {
  const {
    auth,
    events,
    invites,
    presentation,
    join,
    assets,
    artifacts,
    settings,
    egress,
    adminToken,
    previewToken,
  } = deps;

  async function requireAdmin(req: HttpRequest): Promise<AdminPrincipal> {
    return auth.verify(req.headers["authorization"] ?? req.headers["Authorization"]);
  }

  /**
   * 投影状態を LiveKit の room metadata に載せる (ADR 0022 D-1)。
   *
   * composer は制御 API を叩けないので、これが composer にとっての「状態を読む」経路になる。
   * 失敗しても API 自体は成功扱いにする: 投影の正は DynamoDB 側にあり、metadata は
   * その写しなので、ここで 500 を返すとモデレーターの操作が理由もなく失敗する。
   */
  async function publishRoomMetadata(
    state: PresentationState & { deckUrl?: string },
  ): Promise<void> {
    if (!deps.roomMetadata) return;
    try {
      // ADR 0026 D-2: metadata は全文置換なので、送出中フラグは**発行側がここで埋める**。
      // 呼び出し側に渡させると、スライドを送った拍子に消える (0025 で focusIdentity を
      // まさにその形で落とした)。
      const egressActive = await events
        .get(state.eventId)
        .then((e) => Boolean(e.media?.egress))
        .catch(() => false);
      await deps.roomMetadata.publish(
        state.eventId,
        encodeRoomMetadata({
          slideSource: state.slideSource,
          slidePage: state.slidePage,
          deck: state.deck,
          deckUrl: state.deckUrl,
          // ADR 0025 D-2: 接続時に必ず届くので composer 再接続でも grid に戻らない。
          layout: state.layout,
          focusIdentity: state.focusIdentity,
          // 送出中のときだけ載せる (false を毎回書くと metadata が無駄に変わる)。
          egressActive: egressActive || undefined,
        }),
      );
    } catch (err) {
      // metadata は写しなので操作自体は成功扱いにする。ただし黙って落とすと、
      // composer が 5 分の配り直しで動いてしまい**壊れていることに気づけない**。
      log.warn("room metadata publish failed", { eventId: state.eventId, err });
    }
  }

  /**
   * 投影状態に、デッキの署名付き GET URL を添えて返す (ADR 0022 D-1)。
   *
   * 署名は失効するので**保存しない**。読むたびに発行する。これにより
   * 「10 分ごとに配り直して署名を更新する」回避策が要らなくなる。
   *
   * URL を添えるのは moderator だけ。`/stage/materials/download-url` が moderator 限定なので、
   * ここで speaker にも渡すとその制限を迂回できてしまう。speaker がページを送るのに要るのは
   * `deck.pageCount` と `slidePage` だけで、stage-web は PDF を描画しない
   * (pdf.js はアップロード時のページ数カウントにしか使っていない)。
   */
  async function withDeckUrl(
    state: PresentationState,
    includeUrl: boolean,
  ): Promise<PresentationState & { deckUrl?: string }> {
    if (!includeUrl || !state.deck || !deps.artifactStore) return state;
    const key = materialKey(state.eventId, state.deck.assetId, state.deck.filename);
    try {
      return { ...state, deckUrl: await deps.artifactStore.presignGet(key) };
    } catch {
      // 資料が消えていても状態自体は返す (画面を真っ白にしない)。
      return state;
    }
  }

  async function route(req: HttpRequest): Promise<HttpResponse> {
    // OPTIONS (CORS preflight) は API Gateway の corsConfiguration が CORS ヘッダを付けるが、
    // $default ルート (JWT) が OPTIONS を吸い込むため、Lambda まで到達する。
    // Lambda 側で認証不要の 204 を返して preflight を成功させる。
    if (req.method === "OPTIONS") return { status: 204, body: null };

    const segments = req.path.replace(/^\/+|\/+$/g, "").split("/");
    const body = (req.body ?? {}) as Record<string, unknown>;

    // 公開: 招待トークン検証 (モデレーター/登壇者の入室時, 認証不要)
    if (req.method === "POST" && req.path === "/invites/verify") {
      const result = await invites.verify(String(body.token ?? ""));
      return json(result.valid ? 200 : 401, result);
    }

    // 公開: 入室 (招待トークン → LiveKit アクセストークン払い出し) (4.1, F-1)
    if (req.method === "POST" && req.path === "/join") {
      const result = await join.join(
        String(body.token ?? ""),
        body.displayName as string | undefined,
      );
      return json(result.ok ? 200 : 401, result);
    }

    // 公開: イベントリクエスト作成 (モデレーター向け、認証不要)
    if (req.method === "POST" && req.path === "/event-requests" && deps.eventRequests) {
      return json(201, await deps.eventRequests.create(body as unknown as CreateEventRequestInput));
    }

    // 公開: pending リクエスト一覧 (タイトル・時間帯のみ、認証不要)
    if (req.method === "GET" && req.path === "/event-requests/public" && deps.eventRequests) {
      const all = await deps.eventRequests.list();
      const pending = all
        .filter((r) => r.status === "pending")
        .map((r) => ({
          id: r.id,
          title: r.title,
          startsAt: r.startsAt,
          endsAt: r.endsAt,
        }));
      return json(200, pending);
    }

    // 公開: イベント公開情報 (タイトル・時間帯のみ)
    if (req.method === "GET" && req.path === "/events/public") {
      const all = await events.list();
      const publicEvents = all.map((e) => ({
        id: e.id,
        title: e.title,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        status: e.status,
      }));
      return json(200, publicEvents);
    }

    // 公開: stage-web の登壇者ビュー右下小窓プレビュー用 (R17-Phase3, ADR 0012 D-6)。
    // 招待トークン (HMAC 署名) を検証 → eventId 解決 → viewer role の preview token を発行。
    // admin-web は `/events/{id}/preview-token` (requireAdmin) を使うが、 stage-web は
    // Cognito JWT を持たないため別経路。
    if (req.method === "POST" && req.path === "/preview-token") {
      if (!previewToken) throw new ServiceUnavailableError("preview token service not configured");
      const inviteToken = String(body.inviteToken ?? "");
      const verified = await invites.verify(inviteToken);
      if (!verified.valid) return json(401, { ok: false, reason: verified.reason });
      const result = await previewToken.issue(verified.eventId);
      return json(201, result);
    }

    // 公開: 登壇者の表示状態変更 (Phase 1: ステージ管理)。
    // 招待トークン (moderator/admin) で認証し、PresentationService を呼ぶ。
    if (
      req.method === "POST" &&
      segments[0] === "presentation" &&
      segments[1] === "speakers" &&
      segments[2]
    ) {
      const inviteToken = String(body.inviteToken ?? "");
      const verified = await invites.verify(inviteToken);
      if (!verified.valid) return json(401, { ok: false, reason: verified.reason });
      if (verified.role !== "moderator") {
        return json(403, { error: "only moderator or admin can change visibility" });
      }
      const eventId = String(body.eventId ?? verified.eventId);
      if (eventId !== verified.eventId) {
        return json(403, { error: "eventId mismatch" });
      }
      const speakerId = segments[2];
      const visibility = body.visibility as SpeakerVisibility;
      if (visibility !== "live" && visibility !== "standby") {
        return json(400, { error: "visibility must be 'live' or 'standby'" });
      }
      return json(200, await presentation.setSpeakerVisibility(eventId, speakerId, visibility));
    }

    // 公開: 投影状態の取得・更新 (invite-token 認証, ADR 0022 D-1)。
    //
    // 投影の正はサーバーにある。後から入った登壇者・モデレーターはこれを読めば
    // 現在のデッキとページが分かるので、DataChannel の配り直しに頼らなくてよい。
    if (segments[0] === "stage" && segments[1] === "presentation") {
      const inviteToken = String(body.inviteToken ?? "");
      const verified = await invites.verify(inviteToken);
      if (!verified.valid) return json(401, { ok: false, reason: verified.reason });
      const eventId = verified.eventId;

      // 取得は speaker にも許す。自分がめくるために現在ページを知る必要がある (ADR 0022 D-1)。
      const isModerator = verified.role === "moderator";
      if (req.method === "POST" && segments[2] === "state") {
        const state = await withDeckUrl(await presentation.getState(eventId), isModerator);
        // moderator の読み取りで room metadata も貼り直す (ADR 0022 D-1)。
        // 署名の更新をここに寄せることで、**クライアントが状態を書き戻さずに済む**。
        // 書き戻すと、他の人がめくった直後に古いページで上書きするレースになる。
        if (isModerator) await publishRoomMetadata(state);
        return json(200, state);
      }
      // 更新は moderator と speaker の両方。PR #218 で登壇者もめくれるようにした。
      if (req.method === "POST" && segments[2] === "slide") {
        if (verified.role !== "moderator" && verified.role !== "speaker") {
          return json(403, { error: "only moderator or speaker can change the slide" });
        }
        const next = await presentation.setSlide(
          eventId,
          body.slideSource as SlideSource | undefined,
          body.slidePage as number | undefined,
          body.deck,
        );
        const withUrl = await withDeckUrl(next, true);
        await publishRoomMetadata(withUrl);
        return json(200, isModerator ? withUrl : next);
      }
      // レイアウト変更は moderator だけ (ADR 0025 D-1)。admin は moderator 招待で入る (D-3)。
      if (req.method === "POST" && segments[2] === "layout") {
        if (!isModerator) {
          return json(403, { error: "only moderator can change the layout" });
        }
        const next = await presentation.setLayout(eventId, body.layout, body.focusIdentity);
        // deckUrl も一緒に貼り直す。metadata は全文置換なので、デッキの署名 URL を
        // 載せ直さないと投影中のスライドが composer から消える。
        await publishRoomMetadata(await withDeckUrl(next, true));
        return json(200, next);
      }
    }

    // 公開: stage-web から Egress を開始・停止する (ADR 0026 D-3, moderator のみ)。
    // admin は ADR 0025 D-3 の moderator 招待トークンで入るので、この 1 経路で両方通る。
    if (req.method === "POST" && segments[0] === "stage" && segments[1] === "egress") {
      if (!egress) throw new ServiceUnavailableError("egress not configured");
      const inviteToken = String(body.inviteToken ?? "");
      const verified = await invites.verify(inviteToken);
      if (!verified.valid) return json(401, { ok: false, reason: verified.reason });
      if (verified.role !== "moderator") {
        return json(403, { error: "only moderator can control the egress" });
      }
      const eventId = verified.eventId;
      if (segments[2] === "start") {
        const result = await egress.start(eventId);
        await publishRoomMetadata(await withDeckUrl(await presentation.getState(eventId), true));
        return json(202, result);
      }
      if (segments[2] === "stop") {
        const result = await egress.stop(eventId);
        await publishRoomMetadata(await withDeckUrl(await presentation.getState(eventId), true));
        return json(200, result);
      }
    }

    // 公開: stage-web からアセット一覧取得 (invite-token 認証, Phase 3)。
    if (req.method === "POST" && req.path === "/stage/assets") {
      if (!deps.assetMetadataRepo)
        throw new ServiceUnavailableError("asset metadata not configured");
      const inviteToken = String(body.inviteToken ?? "");
      const verified = await invites.verify(inviteToken);
      if (!verified.valid) return json(401, { ok: false, reason: verified.reason });
      if (verified.role !== "moderator") {
        return json(403, { error: "only moderator can access assets" });
      }
      const assets_ = await deps.assetMetadataRepo.list();
      return json(200, { assets: assets_ });
    }

    // 公開: stage-web からアセットのダウンロード URL 取得 (invite-token 認証, Phase 3)。
    if (req.method === "POST" && req.path === "/stage/assets/download-url") {
      if (!deps.artifactStore || !deps.assetMetadataRepo)
        throw new ServiceUnavailableError("asset storage not configured");
      const inviteToken = String(body.inviteToken ?? "");
      const verified = await invites.verify(inviteToken);
      if (!verified.valid) return json(401, { ok: false, reason: verified.reason });
      if (verified.role !== "moderator") {
        return json(403, { error: "only moderator can access assets" });
      }
      const assetKey = String(body.assetKey ?? "");
      if (!assetKey) return json(400, { error: "assetKey is required" });
      // ライブラリ登録済みのキーだけ presign する。任意キーを許すと招待トークンだけで
      // 他イベントの録画・字幕・証明書まで取得できてしまう。
      // ponytail: 全件 list の線形探索。ライブラリが数百件を超えたら assetKey 引きの get を足す。
      const known = (await deps.assetMetadataRepo.list()).some((a) => a.assetKey === assetKey);
      if (!known) return json(404, { error: "asset not found" });
      const downloadUrl = await deps.artifactStore.presignGet(assetKey);
      return json(200, { downloadUrl });
    }

    // 公開: stage-web からデッキ (事前アップロードスライド PDF) のアップロード URL 取得
    // (invite-token 認証, F-3, DESIGN.md 5.2)。`assets/decks/{eventId}/` 配下に PDF のみ許可。
    if (req.method === "POST" && req.path === "/stage/materials/upload-url") {
      if (!deps.materials) throw new ServiceUnavailableError("material storage not configured");
      const inviteToken = String(body.inviteToken ?? "");
      const verified = await invites.verify(inviteToken);
      if (!verified.valid) return json(401, { ok: false, reason: verified.reason });
      if (verified.role !== "moderator") {
        return json(403, { error: "only moderator can upload materials" });
      }
      const filename = String(body.filename ?? "deck.pdf");
      const contentType = String(body.contentType ?? "application/pdf");
      const result = await deps.materials.createUploadUrl(verified.eventId, filename, contentType);
      return json(201, result);
    }

    // 公開: stage-web から資料 (投影用 PDF) のダウンロード URL 取得 (invite-token 認証, F-3, 5.2)。
    // composer-template が署名付き GET URL から pdf.js で描画するために使う。
    if (req.method === "POST" && req.path === "/stage/materials/download-url") {
      if (!deps.artifactStore) throw new ServiceUnavailableError("material storage not configured");
      const inviteToken = String(body.inviteToken ?? "");
      const verified = await invites.verify(inviteToken);
      if (!verified.valid) return json(401, { ok: false, reason: verified.reason });
      if (verified.role !== "moderator") {
        return json(403, { error: "only moderator can access materials" });
      }
      const assetKey = String(body.assetKey ?? "");
      if (!assetKey) return json(400, { error: "assetKey is required" });
      // 資料プレフィックス配下のキーだけ presign する (任意キーを許すと他イベントの素材を取得できる)。
      const prefix = materialsPrefix(verified.eventId);
      if (!assetKey.startsWith(prefix)) return json(404, { error: "material not found" });
      const downloadUrl = await deps.artifactStore.presignGet(assetKey);
      return json(200, { downloadUrl });
    }

    // 公開: 演出プリセット CRUD (invite-token 認証, Phase 4)。
    // 一覧は POST /stage/presets/list。Lambda adapter は rawPath (query なし) しか渡さないため
    // GET + query は使えず、作成 (POST /stage/presets) と衝突しないパスに分ける。
    if (segments[0] === "stage" && segments[1] === "presets") {
      if (!deps.presetRepo) throw new ServiceUnavailableError("preset repo not configured");
      const inviteToken = String(body.inviteToken ?? "");
      const verified = await invites.verify(inviteToken);
      if (!verified.valid) return json(401, { ok: false, reason: verified.reason });
      if (verified.role !== "moderator") {
        return json(403, { error: "only moderator can manage presets" });
      }
      const eventId = verified.eventId;
      const presetId = segments[2];

      if (presetId === "list" && req.method === "POST") {
        const presets = await deps.presetRepo.listByEvent(eventId);
        return json(200, { presets });
      }
      if (!presetId && req.method === "POST") {
        // config 欠落/不正を永続化すると全クライアントの描画が p.config.kind で落ちるため弾く。
        const config = body.config as Preset["config"] | undefined;
        if (!config || typeof config !== "object" || typeof config.kind !== "string") {
          return json(400, { error: "config.kind is required" });
        }
        const newId = deps.newId ?? (() => crypto.randomUUID());
        const nowFn = deps.now ?? Date.now;
        const existing = await deps.presetRepo.listByEvent(eventId);
        const preset: Preset = {
          presetId: newId(),
          eventId,
          config,
          label: String(body.label ?? ""),
          sortOrder: existing.length,
          createdAt: new Date(nowFn()).toISOString(),
        };
        await deps.presetRepo.put(preset);
        return json(201, { preset });
      }
      if (presetId && req.method === "DELETE") {
        await deps.presetRepo.delete(eventId, presetId);
        return json(204, null);
      }
    }

    // ここが境界。**これより上に招待トークン認証のルートを足したら、
    // `packages/shared/public-routes.json` にも必ず足すこと** (ADR 0001 D-10)。
    // 忘れると API Gateway の JWT authorizer に弾かれ、**Lambda に届く前に 401** になる。
    // ローカルのテストは createApp を直接叩くので API Gateway を通らず、この抜けを検知できない。
    // 過去 3 回踏んでいる。
    //
    // 以降は管理者専用 (Cognito)
    const principal = await requireAdmin(req);

    // /assets (グローバルアセットライブラリ, Cognito 認証)
    if (segments[0] === "assets") {
      const assetId = segments[1];

      if (!assetId && req.method === "POST" && segments.length === 1) {
        // POST /assets/upload-url は下の分岐で処理
      }
      if (segments[1] === "upload-url" && req.method === "POST") {
        if (!assets) throw new ServiceUnavailableError("asset storage not configured");
        if (!deps.assetMetadataRepo)
          throw new ServiceUnavailableError("asset metadata not configured");
        const filename = String(body.filename ?? "asset");
        const contentType = String(body.contentType ?? "application/octet-stream");
        const result = await assets.createUploadUrl(filename, contentType);
        const nowFn = deps.now ?? Date.now;
        const asset: AssetMetadata = {
          assetId: result.assetId,
          assetKey: result.key,
          filename,
          contentType,
          tags: (body.tags as string[]) ?? [],
          description: body.description as string | undefined,
          createdAt: new Date(nowFn()).toISOString(),
        };
        await deps.assetMetadataRepo.put(asset);
        return json(201, { ...result, assetId: asset.assetId });
      }
      if (!assetId && req.method === "GET") {
        if (!deps.assetMetadataRepo)
          throw new ServiceUnavailableError("asset metadata not configured");
        const allAssets = await deps.assetMetadataRepo.list();
        const tagFilter = new URLSearchParams(req.path.split("?")[1] ?? "").get("tag");
        const searchFilter = new URLSearchParams(req.path.split("?")[1] ?? "").get("search");
        let filtered = tagFilter ? allAssets.filter((a) => a.tags.includes(tagFilter)) : allAssets;
        if (searchFilter) {
          const q = searchFilter.toLowerCase();
          filtered = filtered.filter(
            (a) =>
              a.filename.toLowerCase().includes(q) ||
              (a.description?.toLowerCase().includes(q) ?? false),
          );
        }
        return json(200, { assets: filtered });
      }
      if (assetId && req.method === "PATCH") {
        if (!deps.assetMetadataRepo)
          throw new ServiceUnavailableError("asset metadata not configured");
        const tags = body.tags as string[] | undefined;
        const description = body.description as string | undefined;
        let updated: AssetMetadata | undefined;
        if (tags && Array.isArray(tags)) {
          updated = await deps.assetMetadataRepo.updateTags(assetId, tags);
        }
        if (description !== undefined) {
          updated = await deps.assetMetadataRepo.updateDescription(assetId, description);
        }
        if (!updated) {
          updated = await deps.assetMetadataRepo.get(assetId);
        }
        return json(200, updated);
      }
      if (assetId && req.method === "DELETE") {
        if (!deps.assetMetadataRepo)
          throw new ServiceUnavailableError("asset metadata not configured");
        const asset = await deps.assetMetadataRepo.get(assetId);
        if (asset && deps.artifactStore) {
          await deps.artifactStore.deletePrefix(asset.assetKey);
        }
        await deps.assetMetadataRepo.delete(assetId);
        return json(204, null);
      }
    }

    // /events
    if (segments[0] === "events") {
      const eventId = segments[1];

      if (!eventId) {
        if (req.method === "POST")
          return json(201, await events.create(body as unknown as CreateEventInput));
        if (req.method === "GET") return json(200, await events.list());
      } else if (segments.length === 2) {
        if (req.method === "GET") return json(200, await events.get(eventId));
        if (req.method === "PATCH") return json(200, await events.update(eventId, body));
        if (req.method === "DELETE") {
          await events.remove(eventId);
          return json(204, null);
        }
      } else if (segments[2] === "status" && req.method === "POST") {
        return json(200, await events.setStatus(eventId, body.status as never));
      } else if (segments[2] === "materials") {
        // 翻訳参考資料 (ADR 0021 D-1)。イベント準備の段階で事前に登録できるようにする。
        // 当日 stage-web から入れる投影デッキも同じ prefix に置かれる。
        if (!deps.artifactStore) {
          throw new ServiceUnavailableError("material storage not configured");
        }
        if (segments.length === 3 && req.method === "GET") {
          const objects = await deps.artifactStore.list(materialsPrefix(eventId));
          // _context.json は抽出結果であって資料ではないので一覧から外す。
          const items = objects
            .map((o) => ({ object: o, parsed: parseMaterialKey(o.key) }))
            .flatMap(({ object, parsed }) =>
              parsed
                ? [{ assetId: parsed.assetId, filename: parsed.filename, key: object.key }]
                : [],
            );
          return json(200, { materials: items });
        }
        if (segments[3] === "upload-url" && req.method === "POST") {
          if (!deps.materials) {
            throw new ServiceUnavailableError("material storage not configured");
          }
          const result = await deps.materials.createUploadUrl(
            eventId,
            String(body.filename ?? ""),
            String(body.contentType ?? ""),
          );
          return json(201, result);
        }
        if (segments[3] && req.method === "DELETE") {
          // assetId 配下をまとめて消す。消えると S3 通知で _context.json も作り直される。
          await deps.artifactStore.deletePrefix(`${materialsPrefix(eventId)}${segments[3]}/`);
          return json(204, null);
        }
      } else if (segments[2] === "presentation") {
        if (segments.length === 3 && req.method === "GET") {
          return json(200, await presentation.getState(eventId));
        }
        if (segments[3] === "speakers" && req.method === "POST") {
          return json(
            200,
            await presentation.setSpeakerVisibility(
              eventId,
              String(body.speakerId),
              body.visibility as SpeakerVisibility,
            ),
          );
        }
        if (segments[3] === "slide" && req.method === "POST") {
          const next = await presentation.setSlide(
            eventId,
            body.slideSource as SlideSource | undefined,
            body.slidePage as number | undefined,
            body.deck,
          );
          const withUrl = await withDeckUrl(next, true);
          await publishRoomMetadata(withUrl);
          return json(200, withUrl);
        }
      } else if (segments[2] === "invites" && req.method === "POST") {
        // 存在しないイベントへの招待発行を防ぐ (無ければ NotFound → 404)。
        await events.get(eventId);
        return json(
          201,
          await invites.issue({
            eventId,
            role: body.role as InvitedRole,
            ttlSec: Number(body.ttlSec ?? 60 * 60 * 12),
          }),
        );
      } else if (segments[2] === "artifacts" && segments.length === 3 && req.method === "GET") {
        // 配信成果物 (録画 / 確定字幕) のダウンロード URL 一覧 (N1)。
        if (!artifacts) throw new ServiceUnavailableError("asset storage not configured");
        return json(200, await artifacts.listArtifacts(eventId));
      } else if (
        segments[2] === "egress" &&
        segments[3] === "start" &&
        segments.length === 4 &&
        req.method === "POST"
      ) {
        // R12: YouTube への RTMP 送出を開始する (LiveKit Egress 起動)。
        // 事前条件: event.status === "live", event.media.livekitUrl 確定済み,
        //          event.youtube.rtmpUrl と event.youtube.streamKeyRef が設定済み。
        if (!egress) throw new ServiceUnavailableError("egress not configured");
        return json(202, await egress.start(eventId));
      } else if (segments[2] === "admin-token" && segments.length === 3 && req.method === "POST") {
        if (!adminToken) throw new ServiceUnavailableError("admin token service not configured");
        return json(201, await adminToken.issue(eventId));
      } else if (segments[2] === "stage-token" && segments.length === 3 && req.method === "POST") {
        // ADR 0014 D-4: admin が stage-web に入るための LiveKit token 発行。
        // identity は admin-{userId}-{uuid} (タブごとに別 participant にする)。
        if (!adminToken) throw new ServiceUnavailableError("admin token service not configured");
        return json(201, await adminToken.issueStageToken(eventId, principal.userId));
      } else if (
        segments[2] === "preview-token" &&
        segments.length === 3 &&
        req.method === "POST"
      ) {
        // R17 / ADR 0012 D-6: プレビュー用 LiveKit token を払い出す (viewer role)。
        // admin-web / stage-web が composer-template を iframe で開く際に使う。
        // 認証は requireAdmin (Cognito JWT) で完了済 (R17-Phase1)。
        // 将来 R17-Phase3 で stage-web 用に invite token 検証経由のパスを追加検討。
        if (!previewToken)
          throw new ServiceUnavailableError("preview token service not configured");
        return json(201, await previewToken.issue(eventId));
      }
    }

    // /event-requests (管理者)
    if (segments[0] === "event-requests" && deps.eventRequests) {
      const requestId = segments[1];
      if (!requestId && req.method === "GET") {
        return json(200, await deps.eventRequests.list());
      }
      if (requestId && segments[2] === "approve" && req.method === "POST") {
        return json(200, await deps.eventRequests.approve(requestId));
      }
      if (requestId && segments[2] === "reject" && req.method === "POST") {
        return json(
          200,
          await deps.eventRequests.reject(requestId, body.reason as string | undefined),
        );
      }
    }

    // /settings/livekit | /settings/youtube : 運用設定 (LiveKit / YouTube) の取得・更新
    // (ADR D-10, ADR 0008 D-7: URL は per-event 化により撤去)
    if (segments[0] === "settings") {
      if (!settings) throw new ServiceUnavailableError("settings store not configured");
      if (segments.length === 2 && segments[1] === "livekit") {
        if (req.method === "GET") return json(200, await settings.getLiveKit());
        if (req.method === "PUT") return json(200, await settings.putLiveKit(body));
      } else if (segments.length === 2 && segments[1] === "youtube") {
        if (req.method === "GET") return json(200, await settings.getYouTube());
        if (req.method === "PUT") return json(200, await settings.putYouTube(body));
      } else if (
        segments.length === 3 &&
        segments[1] === "livekit" &&
        segments[2] === "regenerate" &&
        req.method === "POST"
      ) {
        // サーバ側で API キー/シークレットを生成し Secret に保存する。
        // 生成値はレスポンスに含めない (configured のみ)。
        return json(200, await settings.regenerateLiveKit());
      }
    }

    // /invites/{jti}/reissue|revoke
    if (segments[0] === "invites" && segments[1] && req.method === "POST") {
      const jti = segments[1];
      if (segments[2] === "reissue") {
        return json(201, await invites.reissue(jti, Number(body.ttlSec ?? 60 * 60 * 12)));
      }
      if (segments[2] === "revoke") {
        await invites.revoke(jti);
        return json(204, null);
      }
    }

    return json(404, { error: "route not found" });
  }

  async function handle(req: HttpRequest): Promise<HttpResponse> {
    try {
      return await route(req);
    } catch (err) {
      if (err instanceof UnauthorizedError) return json(401, { error: err.message });
      if (err instanceof ValidationError) return json(400, { error: err.message });
      if (err instanceof NotFoundError) return json(404, { error: err.message });
      if (err instanceof ServiceUnavailableError) {
        const headers = err.retryAfterSec
          ? { "Retry-After": String(err.retryAfterSec) }
          : undefined;
        return { status: 503, body: { error: err.message }, headers };
      }
      return json(500, { error: err instanceof Error ? err.message : "internal error" });
    }
  }

  return { handle };
}

export type App = ReturnType<typeof createApp>;
