/**
 * LiveKit アクセストークンの発行抽象 (DESIGN.md 4.1, 5 章)。
 *
 * 招待トークンを検証した参加者に、SFU(LiveKit) 接続用のアクセストークンを払い出す。
 * 署名鍵 (LiveKit apiKey/apiSecret) は制御層で安全に保持し、ブラウザには渡さない (ADR D-10)。
 * 既定実装は media-composer の純粋なトークン生成関数を用いる。テストはフェイクを注入する。
 */
import type { Role } from '@stagecast/shared';
import { createLiveKitAccessToken } from '@stagecast/media-composer';

export interface MintInput {
  identity: string;
  room: string;
  role: Role;
  ttlSec: number;
  name?: string;
}

export interface LiveKitTokenMinter {
  /** SFU 接続先 URL (wss://...)。 */
  readonly url: string;
  mint(input: MintInput): string;
}

export interface LiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
}

export class DefaultLiveKitTokenMinter implements LiveKitTokenMinter {
  readonly url: string;
  constructor(private readonly config: LiveKitConfig) {
    this.url = config.url;
  }
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
