/**
 * 素材アップロード用の S3 署名付き URL 発行 (DESIGN.md 8 章, 3.1)。
 *
 * 管理コンソールは発行された PUT URL に直接アップロードする (Lambda を経由しない)。
 * 署名は AssetUploadSigner 抽象に委ね、テストではフェイクを注入する。
 */
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ValidationError } from "../usecases/events.js";

export interface PresignedUpload {
  key: string;
  uploadUrl: string;
}

export interface AssetUploadSigner {
  presignPut(key: string, contentType: string): Promise<string>;
}

/** S3 実装。getSignedUrl で有効期限付き PUT URL を発行する。 */
export class S3AssetUploadSigner implements AssetUploadSigner {
  constructor(
    private readonly bucket: string,
    private readonly client: S3Client = new S3Client({}),
    private readonly expiresSec = 900,
  ) {}
  async presignPut(key: string, contentType: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: this.expiresSec },
    );
  }
}

export function createAssetUploadService(deps: { signer: AssetUploadSigner; newId: () => string }) {
  async function createUploadUrl(
    filename: string,
    contentType: string,
  ): Promise<PresignedUpload & { assetId: string }> {
    const assetId = deps.newId();
    const safe = filename.replace(/[^\w.-]/g, "_");
    const key = `assets/library/${assetId}-${safe}`;
    const uploadUrl = await deps.signer.presignPut(key, contentType);
    return { assetId, key, uploadUrl };
  }
  return { createUploadUrl };
}

/** 翻訳参考資料のアップロード (ADR 0021 D-1)。投影用のデッキもこれで登録する。 */
export interface MaterialUpload {
  key: string;
  uploadUrl: string;
  assetId: string;
}

/**
 * 翻訳参考資料として扱える content-type (ADR 0021 D-2)。
 * 抽出できない形式を受け付けても `_context.json` に載らないので、入口で弾く。
 */
const MATERIAL_CONTENT_TYPES = new Map<string, string[]>([
  ["application/pdf", ["pdf"]],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", ["pptx"]],
  ["text/markdown", ["md", "markdown"]],
  ["text/plain", ["txt", "text", "md"]],
]);

function extensionOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i < 0 ? "" : filename.slice(i + 1).toLowerCase();
}

/**
 * 翻訳参考資料のアップロード署名サービス。`assets/materials/{eventId}/{assetId}/{filename}` に置く。
 *
 * 抽出 Lambda の `parseMaterialKey` が **3 段ちょうど**を期待するので、assetId と filename は
 * `/` で分ける (`-` で繋ぐと 2 段になり、資料として認識されない)。ファイル名の `/` は
 * サニタイズで `_` になるため段数は増えない。
 */
export function createMaterialUploadService(deps: {
  signer: AssetUploadSigner;
  newId: () => string;
}) {
  async function createUploadUrl(
    eventId: string,
    filename: string,
    contentType: string,
  ): Promise<MaterialUpload> {
    const allowedExts = MATERIAL_CONTENT_TYPES.get(contentType);
    if (!allowedExts) {
      throw new ValidationError(`unsupported material content-type: ${contentType}`);
    }
    const ext = extensionOf(filename);
    if (!allowedExts.includes(ext)) {
      throw new ValidationError(`filename extension does not match content-type: ${filename}`);
    }
    const assetId = deps.newId();
    const safe = filename.replace(/[^\w.-]/g, "_");
    const key = `assets/materials/${eventId}/${assetId}/${safe}`;
    const uploadUrl = await deps.signer.presignPut(key, contentType);
    return { assetId, key, uploadUrl };
  }
  return { createUploadUrl };
}
