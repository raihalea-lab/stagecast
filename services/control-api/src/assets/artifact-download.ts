/**
 * 配信成果物 (録画 / 確定字幕) のダウンロード用 署名付き GET URL 発行 (N1, DESIGN.md 6.4 / N-4)。
 *
 * 管理コンソールはイベント配下の S3 オブジェクトを一覧し、各オブジェクトの有効期限付き
 * GET URL を受け取って直接ダウンロードする (Lambda を経由しない)。S3 操作は `ArtifactStore`
 * 抽象に委ね、テストではフェイクを注入する (CLAUDE.md テスト方針)。
 */
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export type ArtifactKind = "recording" | "caption";

export interface Artifact {
  kind: ArtifactKind;
  key: string;
  /** プレフィックスを除いた表示名 (例: lk-egress-1.mp4)。 */
  name: string;
  downloadUrl: string;
  size?: number;
}

export interface ArtifactObject {
  key: string;
  size?: number | undefined;
}

export interface ArtifactStore {
  /** プレフィックス配下のオブジェクトを列挙する。 */
  list(prefix: string): Promise<ArtifactObject[]>;
  /** 有効期限付き GET URL を発行する。 */
  presignGet(key: string): Promise<string>;
}

/** S3 実装。ListObjectsV2 + getSignedUrl(GetObject) で一覧と DL URL を返す。 */
export class S3ArtifactStore implements ArtifactStore {
  constructor(
    private readonly bucket: string,
    private readonly client: S3Client = new S3Client({}),
    private readonly expiresSec = 900,
  ) {}

  async list(prefix: string): Promise<ArtifactObject[]> {
    const out: ArtifactObject[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of res.Contents ?? []) {
        if (o.Key && !o.Key.endsWith("/")) out.push({ key: o.Key, size: o.Size });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async presignGet(key: string): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: this.expiresSec,
    });
  }
}

/** 成果物プレフィックス規約 (Egress 録画 / caption-pipeline 確定字幕)。 */
const PREFIXES: { kind: ArtifactKind; prefix: (eventId: string) => string }[] = [
  { kind: "recording", prefix: (id) => `recordings/${id}/` },
  { kind: "caption", prefix: (id) => `captions/${id}/` },
];

export function createArtifactDownloadService(deps: { store: ArtifactStore }) {
  async function listArtifacts(eventId: string): Promise<{ artifacts: Artifact[] }> {
    const artifacts: Artifact[] = [];
    for (const group of PREFIXES) {
      const prefix = group.prefix(eventId);
      for (const obj of await deps.store.list(prefix)) {
        artifacts.push({
          kind: group.kind,
          key: obj.key,
          name: obj.key.slice(prefix.length),
          downloadUrl: await deps.store.presignGet(obj.key),
          ...(obj.size !== undefined ? { size: obj.size } : {}),
        });
      }
    }
    return { artifacts };
  }
  return { listArtifacts };
}
