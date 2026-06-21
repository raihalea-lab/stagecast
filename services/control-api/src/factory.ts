/**
 * 制御 API の組み立て (依存の配線)。
 *
 * 既定ではインメモリ・リポジトリとフェイク認証で構成し、外部接続なしに動作する
 * (PROMPT 共通ルール)。本番では DynamoDB 実装・Cognito 検証器に差し替える。
 */
import { randomUUID } from "node:crypto";
import { FakeAdminAuthVerifier, type AdminAuthVerifier } from "./auth/admin-auth.js";
import {
  MemoryEventRepository,
  MemoryInviteTokenRepository,
  MemoryPresentationRepository,
} from "./repo/memory.js";
import type {
  EventRepository,
  InviteTokenRepository,
  PresentationRepository,
} from "./repo/types.js";
import { createEventService } from "./usecases/events.js";
import { createInviteService } from "./usecases/invites.js";
import { createPresentationService } from "./usecases/presentation.js";
import { createJoinService, type IceServerProvider } from "./usecases/join.js";
import {
  createEgressService,
  type EgressStarter,
  type StreamKeyResolver,
} from "./usecases/egress.js";
import { createAdminTokenService } from "./usecases/admin-token.js";
import { DefaultLiveKitTokenMinter, type LiveKitTokenMinter } from "./auth/livekit-minter.js";
import { dynamoRepositories } from "./repo/dynamo.js";
import {
  createAssetUploadService,
  S3AssetUploadSigner,
  type AssetUploadSigner,
} from "./assets/asset-upload.js";
import {
  createArtifactDownloadService,
  S3ArtifactStore,
  type ArtifactStore,
} from "./assets/artifact-download.js";
import { createApp } from "./http/app.js";
import type { SettingsService } from "./usecases/settings.js";

export interface FactoryConfig {
  auth?: AdminAuthVerifier;
  eventRepo?: EventRepository;
  inviteRepo?: InviteTokenRepository;
  presentationRepo?: PresentationRepository;
  inviteSecret?: string;
  inviteBaseUrl?: string;
  /** LiveKit トークン発行器 (入室時に使用)。未指定なら環境変数から構築を試みる。 */
  livekitMinter?: LiveKitTokenMinter;
  /** 素材アップロード署名器。未指定なら ASSETS_BUCKET_NAME があれば S3 実装を使う。 */
  assetSigner?: AssetUploadSigner;
  /** 成果物ダウンロード用 S3 ストア。未指定なら ASSETS_BUCKET_NAME があれば S3 実装を使う。 */
  artifactStore?: ArtifactStore;
  /** 運用設定 (LiveKit / YouTube 認証情報) 管理サービス。注入 > 環境変数解決 (lambda.ts 側で行う) > 503。 */
  settings?: SettingsService;
  /** LiveKit Egress を起動するアダプタ (R12)。指定時のみ `egress` サービスが構築される。 */
  egressStarter?: EgressStarter;
  /** YouTube ストリームキーを解決するアダプタ (R12)。egressStarter と組み合わせて使う。 */
  streamKeyResolver?: StreamKeyResolver;
  /** R12-followup-19: ICE 用 TURN を取得する provider (本番 = KVS, テスト = fake)。 */
  iceServerProvider?: IceServerProvider;
  now?: () => number;
  newId?: () => string;
}

/** 環境変数から LiveKit 設定が揃っていれば既定の発行器を作る (ADR 0008 D-5: URL は不要)。 */
function livekitFromEnv(): LiveKitTokenMinter | undefined {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (apiKey && apiSecret) {
    return new DefaultLiveKitTokenMinter({ apiKey, apiSecret });
  }
  return undefined;
}

export function buildControlApi(config: FactoryConfig = {}) {
  const now = config.now ?? Date.now;
  const newId = config.newId ?? randomUUID;
  const secret = config.inviteSecret ?? process.env.INVITE_TOKEN_SECRET ?? "dev-insecure-secret";
  const baseUrl =
    config.inviteBaseUrl ?? process.env.INVITE_BASE_URL ?? "https://app.stagecast.local/join";

  // METADATA_TABLE_NAME があれば DynamoDB、無ければインメモリ (ローカル/テスト)。
  // 明示的に repo が注入された場合はそちらを優先する。
  const tableName = process.env.METADATA_TABLE_NAME;
  const dynamo = tableName ? dynamoRepositories(tableName) : undefined;

  const events = createEventService({
    repo: config.eventRepo ?? dynamo?.eventRepo ?? new MemoryEventRepository(),
    newId,
    now,
  });
  const invites = createInviteService({
    repo: config.inviteRepo ?? dynamo?.inviteRepo ?? new MemoryInviteTokenRepository(),
    secret,
    newJti: newId,
    now,
    baseUrl,
  });
  const presentation = createPresentationService({
    repo: config.presentationRepo ?? dynamo?.presentationRepo ?? new MemoryPresentationRepository(),
    now,
  });
  const join = createJoinService({
    invites,
    events,
    minter: config.livekitMinter ?? livekitFromEnv(),
    newIdentity: newId,
    ...(config.iceServerProvider ? { iceServerProvider: config.iceServerProvider } : {}),
  });

  // 素材アップロード署名: 注入 > ASSETS_BUCKET_NAME から S3 実装 > 無効 (503)。
  const assetsBucket = process.env.ASSETS_BUCKET_NAME;
  const assetSigner =
    config.assetSigner ?? (assetsBucket ? new S3AssetUploadSigner(assetsBucket) : undefined);
  const assets = assetSigner ? createAssetUploadService({ signer: assetSigner, newId }) : undefined;

  // 成果物ダウンロード: 注入 > ASSETS_BUCKET_NAME から S3 実装 > 無効 (503)。
  const artifactStore =
    config.artifactStore ?? (assetsBucket ? new S3ArtifactStore(assetsBucket) : undefined);
  const artifacts = artifactStore
    ? createArtifactDownloadService({ store: artifactStore })
    : undefined;

  // R12: Egress 起動サービス。starter と resolver の両方が注入されたときのみ有効化する。
  const egress =
    config.egressStarter && config.streamKeyResolver
      ? createEgressService({
          events,
          starter: config.egressStarter,
          streamKeyResolver: config.streamKeyResolver,
        })
      : undefined;

  // R16 / ADR 0012 D-4: 管理者用 LiveKit token 発行 (layout 切替 broadcast 用)。
  // livekitMinter が無い (LiveKit 環境変数未設定) 環境ではこのサービスは無効。
  const liveKitMinter = config.livekitMinter ?? livekitFromEnv();
  const adminToken = liveKitMinter
    ? createAdminTokenService({ events, liveKitMinter })
    : undefined;

  return createApp({
    auth: config.auth ?? new FakeAdminAuthVerifier(),
    events,
    invites,
    presentation,
    join,
    assets,
    artifacts,
    settings: config.settings,
    egress,
    adminToken,
  });
}
