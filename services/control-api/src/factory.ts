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
import { createApp } from './http/app.js';

export interface FactoryConfig {
  auth?: AdminAuthVerifier;
  eventRepo?: EventRepository;
  inviteRepo?: InviteTokenRepository;
  presentationRepo?: PresentationRepository;
  inviteSecret?: string;
  inviteBaseUrl?: string;
  now?: () => number;
  newId?: () => string;
}

export function buildControlApi(config: FactoryConfig = {}) {
  const now = config.now ?? Date.now;
  const newId = config.newId ?? randomUUID;
  const secret = config.inviteSecret ?? process.env.INVITE_TOKEN_SECRET ?? 'dev-insecure-secret';
  const baseUrl =
    config.inviteBaseUrl ?? process.env.INVITE_BASE_URL ?? 'https://app.stagecast.local/join';

  const events = createEventService({
    repo: config.eventRepo ?? new MemoryEventRepository(),
    newId,
    now,
  });
  const invites = createInviteService({
    repo: config.inviteRepo ?? new MemoryInviteTokenRepository(),
    secret,
    newJti: newId,
    now,
    baseUrl,
  });
  const presentation = createPresentationService({
    repo: config.presentationRepo ?? new MemoryPresentationRepository(),
    now,
  });

  return createApp({
    auth: config.auth ?? new FakeAdminAuthVerifier(),
    events,
    invites,
    presentation,
  });
}
