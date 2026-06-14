/**
 * 素材アップロードのローカル実装 (DESIGN.md 8 章)。
 * 本番は S3 署名付き URL を取得して PUT する。ローカルはインメモリ保管で代替する。
 */
import type { AssetRef } from "@stagecast/shared";
import type { AssetService } from "./types.js";

export class InMemoryAssetService implements AssetService {
  readonly stored = new Map<string, { contentType: string; bytes: Uint8Array }>();

  async upload(
    eventId: string,
    file: { name: string; contentType: string; bytes: Uint8Array },
  ): Promise<AssetRef> {
    const key = `assets/${eventId}/${file.name}`;
    this.stored.set(key, { contentType: file.contentType, bytes: file.bytes });
    return { key, label: file.name, contentType: file.contentType };
  }
}
