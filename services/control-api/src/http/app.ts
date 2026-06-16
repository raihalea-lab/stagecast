/**
 * 制御 API のルーティング層 (フレームワーク非依存)。
 *
 * 正規化した HttpRequest を受け取り HttpResponse を返す。API Gateway 等の
 * トランスポート固有の変換は adapter (index.ts) 側で行う。これにより外部接続なしの
 * 単体テストが容易になる。
 */
import type { InvitedRole, SlideSource, SpeakerVisibility } from "@stagecast/shared";
import type { AdminAuthVerifier } from "../auth/admin-auth.js";
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
import type { createArtifactDownloadService } from "../assets/artifact-download.js";
import type { SettingsService } from "../usecases/settings.js";

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
type ArtifactDownloadService = ReturnType<typeof createArtifactDownloadService>;

export interface AppDeps {
  auth: AdminAuthVerifier;
  events: EventService;
  invites: InviteService;
  presentation: PresentationService;
  join: JoinService;
  /** 素材アップロード署名サービス (S3 未設定なら省略され 503)。 */
  assets?: AssetUploadService;
  /** 成果物ダウンロードサービス (S3 未設定なら省略され 503)。 */
  artifacts?: ArtifactDownloadService;
  /** 運用設定 (LiveKit / YouTube 認証情報) 管理 (Secrets Manager 未設定なら省略され 503)。 */
  settings?: SettingsService;
}

const json = (status: number, body: unknown): HttpResponse => ({ status, body });

export function createApp(deps: AppDeps) {
  const { auth, events, invites, presentation, join, assets, artifacts, settings } = deps;

  async function requireAdmin(req: HttpRequest): Promise<void> {
    await auth.verify(req.headers["authorization"] ?? req.headers["Authorization"]);
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

    // 以降は管理者専用 (Cognito)
    await requireAdmin(req);

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
          return json(
            200,
            await presentation.setSlide(
              eventId,
              body.slideSource as SlideSource | undefined,
              body.slidePage as number | undefined,
            ),
          );
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
      } else if (
        segments[2] === "assets" &&
        segments[3] === "upload-url" &&
        req.method === "POST"
      ) {
        if (!assets) throw new ServiceUnavailableError("asset storage not configured");
        return json(
          201,
          await assets.createUploadUrl(
            eventId,
            String(body.filename ?? "asset"),
            String(body.contentType ?? "application/octet-stream"),
          ),
        );
      } else if (segments[2] === "artifacts" && segments.length === 3 && req.method === "GET") {
        // 配信成果物 (録画 / 確定字幕) のダウンロード URL 一覧 (N1)。
        if (!artifacts) throw new ServiceUnavailableError("asset storage not configured");
        return json(200, await artifacts.listArtifacts(eventId));
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
