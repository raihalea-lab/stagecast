/**
 * 制御 API の組み立て (依存の配線)。
 *
 * 既定ではインメモリ・リポジトリとフェイク認証で構成し、外部接続なしに動作する
 * (PROMPT 共通ルール)。本番では DynamoDB 実装・Cognito 検証器に差し替える。
 */
import { randomUUID } from 'node:crypto';
import { FakeAdminAuthVerifier, type AdminAuthVerifier } from './auth/admin-auth.js';
import {
  MemoryEventRepository,
  MemoryInviteTokenRepository,
  MemoryPresentationRepository,
} from './repo/memory.js';
import type {
  EventRepository,
  InviteTokenRepository,
  PresentationRepository,
} from './repo/types.js';
import { createEventService } from './usecases/events.js';
import { createInviteService } from './usecases/invites.js';
import { createPresentationService } from './usecases/presentation.js';
import { createJoinService } from './usecases/join.js';
import { DefaultLiveKitTokenMinter, type LiveKitTokenMinter } from './auth/livekit-minter.js';
import { dynamoRepositories } from './repo/dynamo.js';
import { createApp } from './http/app.js';

export interface FactoryConfig {
  auth?: AdminAuthVerifier;
  eventRepo?: EventRepository;
  inviteRepo?: InviteTokenRepository;
  presentationRepo?: PresentationRepository;
  inviteSecret?: string;
  inviteBaseUrl?: string;
  /** LiveKit トークン発行器 (入室時に使用)。未指定なら環境変数から構築を試みる。 */
  livekitMinter?: LiveKitTokenMinter;
  now?: () => number;
  newId?: () => string;
}

/** 環境変数から LiveKit 設定が揃っていれば既定の発行器を作る。 */
function livekitFromEnv(): LiveKitTokenMinter | undefined {
  const url = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (url && apiKey && apiSecret) {
    return new DefaultLiveKitTokenMinter({ url, apiKey, apiSecret });
  }
  return undefined;
}

export function buildControlApi(config: FactoryConfig = {}) {
  const now = config.now ?? Date.now;
  const newId = config.newId ?? randomUUID;
  const secret = config.inviteSecret ?? process.env.INVITE_TOKEN_SECRET ?? 'dev-insecure-secret';
  const baseUrl =
    config.inviteBaseUrl ?? process.env.INVITE_BASE_URL ?? 'https://app.stagecast.local/join';

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
    minter: config.livekitMinter ?? livekitFromEnv(),
    newIdentity: newId,
  });

  return createApp({
    auth: config.auth ?? new FakeAdminAuthVerifier(),
    events,
    invites,
    presentation,
    join,
  });
}
