/**
 * 本番用の素材アップロード (DESIGN.md 8 章)。
 * 制御 API から S3 署名付き URL を取得し、ブラウザから直接 PUT する。
 */
import type { AssetRef } from "@stagecast/shared";
import type { AssetService } from "./types.js";

export class HttpAssetService implements AssetService {
  constructor(
    private readonly baseUrl: string,
    private readonly getToken: () => string | undefined,
  ) {}

  async upload(
    eventId: string,
    file: { name: string; contentType: string; bytes: Uint8Array },
  ): Promise<AssetRef> {
    const token = this.getToken();
    const presignRes = await fetch(`${this.baseUrl}/events/${eventId}/assets/upload-url`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ filename: file.name, contentType: file.contentType }),
    });
    if (!presignRes.ok) throw new Error(`presign failed: ${presignRes.status}`);
    const { key, uploadUrl } = (await presignRes.json()) as { key: string; uploadUrl: string };

    const putRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "content-type": file.contentType },
      // Uint8Array は BlobPart 互換だが TS lib の型差異を吸収するためキャスト。
      body: new Blob([file.bytes as unknown as BlobPart], { type: file.contentType }),
    });
    if (!putRes.ok) throw new Error(`upload failed: ${putRes.status}`);

    return { key, label: file.name, contentType: file.contentType };
  }
}
