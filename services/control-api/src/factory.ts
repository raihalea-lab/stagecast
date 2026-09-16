/**
 * 制御 API の組み立て (依存の配線)。
 *
 * 既定ではインメモリ・リポジトリとフェイク認証で構成し、外部接続なしに動作する
 * (PROMPT 共通ルール)。本番では DynamoDB 実装・Cognito 検証器に差し替える。
 */
import { randomUUID } from "node:crypto";
import { materialsPrefix } from "@stagecast/shared";
import { FakeAdminAuthVerifier, type AdminAuthVerifier } from "./auth/admin-auth.js";
import {
  MemoryAssetMetadataRepository,
  MemoryEventRepository,
  MemoryEventRequestRepository,
  MemoryInviteTokenRepository,
  MemoryPresetRepository,
  MemoryPresentationRepository,
} from "./repo/memory.js";
import type {
  AssetMetadataRepository,
  EventRepository,
  EventRequestRepository,
  InviteTokenRepository,
  PresetRepository,
  PresentationRepository,
} from "./repo/types.js";
import { createEventService } from "./usecases/events.js";
import { createEventRequestService } from "./usecases/event-requests.js";
import { createInviteService } from "./usecases/invites.js";
import { createPresentationService } from "./usecases/presentation.js";
import { createJoinService, type IceServerProvider } from "./usecases/join.js";
import {
  createEgressService,
  type EgressStarter,
  type StreamKeyResolver,
} from "./usecases/egress.js";
import { createAdminTokenService } from "./usecases/admin-token.js";
import { createPreviewTokenService } from "./usecases/preview-token.js";
import { DefaultLiveKitTokenMinter, type LiveKitTokenMinter } from "./auth/livekit-minter.js";
import { dynamoRepositories } from "./repo/dynamo.js";
import {
  createAssetUploadService,
  createMaterialUploadService,
  S3AssetUploadSigner,
  type AssetUploadSigner,
} from "./assets/asset-upload.js";
import {
  createArtifactDownloadService,
  S3ArtifactStore,
  type ArtifactStore,
} from "./assets/artifact-download.js";
import { createApp, type RoomMetadataPublisher } from "./http/app.js";
import type { SettingsService } from "./usecases/settings.js";

export interface FactoryConfig {
  auth?: AdminAuthVerifier;
  eventRepo?: EventRepository;
  eventRequestRepo?: EventRequestRepository;
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
  /** ADR 0015 Phase 2: live 遷移時に reconcile Lambda を直接起動するコールバック。 */
  onGoLive?: (eventId: string) => Promise<void>;
  /** ADR 0015 Phase 4: スケジュール事前ウォームアップ。startsAt=string で作成、null で削除。 */
  onWarmupSchedule?: (eventId: string, startsAt: string | null) => Promise<void>;
  /** アセットメタデータリポ。未指定なら DynamoDB or インメモリ。 */
  assetMetadataRepo?: AssetMetadataRepository;
  /** プリセットリポ。未指定なら DynamoDB or インメモリ。 */
  presetRepo?: PresetRepository;
  /** 投影状態を LiveKit の room metadata に載せる (ADR 0022 D-1)。 */
  roomMetadata?: RoomMetadataPublisher;
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

  // S3 ストレージクリーンアップ: イベント削除時にアセット・録画・字幕を全削除する。
  // artifactStore (ArtifactStore) が利用可能な場合のみ有効化。
  const storeBucket = process.env.ASSETS_BUCKET_NAME;
  const cleanupStore =
    config.artifactStore ?? (storeBucket ? new S3ArtifactStore(storeBucket) : undefined);
  const cleanupStorage = cleanupStore
    ? async (eventId: string) => {
        const prefixes = [
          `recordings/${eventId}/`,
          `captions/${eventId}/`,
          // 翻訳参考資料。ここが抜けていたのでイベントを削除しても資料が S3 に残っていた。
          materialsPrefix(eventId),
        ];
        await Promise.all(prefixes.map((p) => cleanupStore.deletePrefix(p)));
      }
    : undefined;

  // イベント終了時は**資料だけ**消す。録画と字幕は成果物として残す (Artifacts タブが読む)。
  // `_context.json` と Translate の用語集は、この削除の S3 通知から materials-extract が
  // 連鎖的に片付ける (ADR 0021)。
  const cleanupMaterials = cleanupStore
    ? async (eventId: string) => {
        await cleanupStore.deletePrefix(materialsPrefix(eventId));
      }
    : undefined;

  const events = createEventService({
    repo: config.eventRepo ?? dynamo?.eventRepo ?? new MemoryEventRepository(),
    newId,
    now,
    cleanupStorage,
    cleanupMaterials,
    onGoLive: config.onGoLive,
    onWarmupSchedule: config.onWarmupSchedule,
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
  // 事前アップロードスライド (PDF) のデッキ用アップロード (F-3, DESIGN.md 5.2)。
  const materials = assetSigner
    ? createMaterialUploadService({ signer: assetSigner, newId })
    : undefined;

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

  const eventRequests = createEventRequestService({
    repo: config.eventRequestRepo ?? dynamo?.eventRequestRepo ?? new MemoryEventRequestRepository(),
    events,
    newId,
    now,
  });

  // R16 / ADR 0012 D-4: 管理者用 LiveKit token 発行 (layout 切替 broadcast 用)。
  // livekitMinter が無い (LiveKit 環境変数未設定) 環境ではこのサービスは無効。
  const liveKitMinter = config.livekitMinter ?? livekitFromEnv();
  const adminToken = liveKitMinter ? createAdminTokenService({ events, liveKitMinter }) : undefined;
  // R17 / ADR 0012 D-6: プレビュー用 LiveKit token 発行 (viewer role, iframe 埋め込み用)。
  const previewToken = liveKitMinter
    ? createPreviewTokenService({ events, liveKitMinter })
    : undefined;

  // アセットメタデータ: 注入 > DynamoDB > インメモリ。
  const assetMetadataRepo =
    config.assetMetadataRepo ?? dynamo?.assetMetadataRepo ?? new MemoryAssetMetadataRepository();

  // プリセット: 注入 > DynamoDB > インメモリ。
  const presetRepo = config.presetRepo ?? dynamo?.presetRepo ?? new MemoryPresetRepository();

  return createApp({
    auth: config.auth ?? new FakeAdminAuthVerifier(),
    events,
    invites,
    presentation,
    join,
    assets,
    materials,
    artifacts,
    settings: config.settings,
    egress,
    adminToken,
    previewToken,
    eventRequests,
    assetMetadataRepo,
    artifactStore,
    presetRepo,
    ...(config.roomMetadata ? { roomMetadata: config.roomMetadata } : {}),
    newId,
    now,
  });
}
