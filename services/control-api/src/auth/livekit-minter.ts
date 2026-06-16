/**
 * LiveKit アクセストークンの発行抽象 (DESIGN.md 4.1, 5 章, ADR 0008 D-5)。
 *
 * 招待トークンを検証した参加者に、SFU(LiveKit) 接続用のアクセストークンを払い出す。
 * 署名鍵 (LiveKit apiKey/apiSecret) は制御層で安全に保持し、ブラウザには渡さない (ADR D-10)。
 * apiKey/apiSecret は全イベント共有 (ADR 0008 D-5)。URL は per-event (events.media.livekitUrl)
 * から取得するため、minter は URL を持たない (ADR 0008 D-1)。
 */
import type { Role } from "@stagecast/shared";
import { createLiveKitAccessToken } from "@stagecast/media-composer";

export interface MintInput {
  identity: string;
  room: string;
  role: Role;
  ttlSec: number;
  name?: string;
}

export interface LiveKitTokenMinter {
  mint(input: MintInput): string;
}

export interface LiveKitConfig {
  apiKey: string;
  apiSecret: string;
}

export class DefaultLiveKitTokenMinter implements LiveKitTokenMinter {
  constructor(private readonly config: LiveKitConfig) {}
  mint(input: MintInput): string {
    return createLiveKitAccessToken({
      apiKey: this.config.apiKey,
      apiSecret: this.config.apiSecret,
      identity: input.identity,
      room: input.room,
      role: input.role,
      issuedAtSec: Math.floor(Date.now() / 1000),
      ttlSec: input.ttlSec,
      name: input.name,
    });
  }
}
