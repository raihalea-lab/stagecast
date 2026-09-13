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

/** 事前アップロードスライド (PDF) のデッキ用アップロード (F-3, DESIGN.md 5.2)。 */
export interface DeckUpload {
  key: string;
  uploadUrl: string;
  assetId: string;
}

/** デッキ用アップロード署名サービス。`assets/decks/{eventId}/` 配下に PDF のみ許可する。 */
export function createDeckUploadService(deps: { signer: AssetUploadSigner; newId: () => string }) {
  async function createUploadUrl(
    eventId: string,
    filename: string,
    contentType: string,
  ): Promise<DeckUpload> {
    if (contentType !== "application/pdf") {
      throw new ValidationError("deck must be application/pdf");
    }
    const assetId = deps.newId();
    const safe = filename.replace(/[^\w.-]/g, "_");
    const key = `assets/decks/${eventId}/${assetId}-${safe}`;
    const uploadUrl = await deps.signer.presignPut(key, contentType);
    return { assetId, key, uploadUrl };
  }
  return { createUploadUrl };
}
