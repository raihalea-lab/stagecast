/**
 * Lambda 起動時の依存解決 (Secrets Manager / Cognito) (T5, T7, ADR D-10)。
 *
 * 同期の `buildControlApi` (factory) はテスト/ローカルで使う。Lambda では
 * 招待トークン秘密鍵 / LiveKit 鍵を Secrets Manager から非同期に取得し、
 * Cognito User Pool 設定があれば JWT 検証器を組み立てて差し込む。
 *
 * 秘密値は cold start で 1 回だけ取得し、warm 中はキャッシュする。
 */
import { randomUUID } from "node:crypto";
import {
  cognitoAdminAuthVerifier,
  FakeAdminAuthVerifier,
  type AdminAuthVerifier,
} from "./auth/admin-auth.js";
import { DefaultLiveKitTokenMinter, type LiveKitTokenMinter } from "./auth/livekit-minter.js";
import { buildControlApi } from "./factory.js";
import { createKvsIceServerProvider } from "./ice/kvs-provider.js";
import type { App } from "./http/app.js";
import {
  createSettingsService,
  type SecretsWriter,
  type SettingsService,
} from "./usecases/settings.js";
import type { EgressStarter, StreamKeyResolver } from "./usecases/egress.js";

/** Secrets Manager の最小読み取り操作。テストでは fake を注入する。 */
export interface SecretsResolver {
  getSecretJson(secretId: string): Promise<Record<string, string>>;
}

/** Secrets Manager の最小書き込み操作 (PutSecretValue)。テストでは fake を注入する。 */
export type SecretsWriterAdapter = SecretsWriter;

class AwsSecretsResolver implements SecretsResolver {
  private clientPromise: Promise<{
    send: (cmd: unknown) => Promise<{ SecretString?: string }>;
  }> | null = null;

  private async client(): Promise<{
    send: (cmd: unknown) => Promise<{ SecretString?: string }>;
  }> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const { SecretsManagerClient } = await import("@aws-sdk/client-secrets-manager");
        return new SecretsManagerClient({}) as unknown as {
          send: (cmd: unknown) => Promise<{ SecretString?: string }>;
        };
      })();
    }
    return this.clientPromise;
  }

  async getSecretJson(secretId: string): Promise<Record<string, string>> {
    const { GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
    const sm = await this.client();
    const res = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (!res.SecretString) throw new Error(`secret ${secretId} has no value`);
    // 値が単純文字列のときは {value: "..."} として扱う (運用者が更新しやすいよう柔軟に)。
    try {
      const parsed = JSON.parse(res.SecretString) as Record<string, string>;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // not JSON: 単純文字列として扱う
    }
    return { value: res.SecretString };
  }
}

/** Secrets Manager に PutSecretValue で JSON 文字列を上書き保存する。 */
class AwsSecretsWriter implements SecretsWriter {
  private clientPromise: Promise<{
    send: (cmd: unknown) => Promise<unknown>;
  }> | null = null;

  private async client(): Promise<{ send: (cmd: unknown) => Promise<unknown> }> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const { SecretsManagerClient } = await import("@aws-sdk/client-secrets-manager");
        return new SecretsManagerClient({}) as unknown as {
          send: (cmd: unknown) => Promise<unknown>;
        };
      })();
    }
    return this.clientPromise;
  }

  async putSecretJson(secretId: string, payload: Record<string, string>): Promise<void> {
    const { PutSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
    const sm = await this.client();
    await sm.send(
      new PutSecretValueCommand({ SecretId: secretId, SecretString: JSON.stringify(payload) }),
    );
  }
}

export interface BuildFromEnvOptions {
  /** Secrets Manager 読み取り (テストでは fake を注入)。 */
  secrets?: SecretsResolver;
  /** Secrets Manager 書き込み (PutSecretValue, テストでは fake を注入)。 */
  secretsWriter?: SecretsWriter;
  /** env (テストでは差し替え可能)。 */
  env?: NodeJS.ProcessEnv;
}

/**
 * 環境変数から制御 API を組み立てる (Lambda エントリ)。
 *
 * 解決順:
 *   - 招待トークン秘密: INVITE_TOKEN_SECRET_ARN > INVITE_TOKEN_SECRET > "dev-insecure-secret"
 *   - LiveKit:         LIVEKIT_SECRET_ARN > LIVEKIT_URL/API_KEY/API_SECRET
 *   - 管理者認証:        COGNITO_USER_POOL_ID + CLIENT_ID があれば Cognito JWT、なければ Fake
 */
export async function buildControlApiFromEnv(options: BuildFromEnvOptions = {}): Promise<App> {
  const env = options.env ?? process.env;
  const secrets = options.secrets ?? new AwsSecretsResolver();
  const secretsWriter = options.secretsWriter ?? new AwsSecretsWriter();

  const inviteSecret = await resolveInviteSecret(env, secrets);
  const livekitMinter = await resolveLiveKit(env, secrets);
  const auth = resolveAdminAuth(env);
  const settings = resolveSettings(env, secrets, secretsWriter);
  // R12: LiveKit Egress と YouTube Secret resolver。
  // - LIVEKIT_SECRET_ARN があれば egressStarter (livekitUrl は per-event で渡される) を構築
  // - YOUTUBE_SECRET_ARN があれば streamKeyResolver を構築
  // どちらかが欠ければ HTTP 層が 503 を返す。
  const egressStarter = resolveEgressStarter(env, secrets);
  const streamKeyResolver = resolveStreamKeyResolver(env, secrets);
  // R12-followup-19: KVS_SIGNALING_CHANNEL_ARN があれば KVS WebRTC TURN provider を構築。
  // 無ければ undefined → /join は iceServers field を返さない (stage-web 側で SFU 直接 UDP に fallback)。
  const iceServerProvider = env.KVS_SIGNALING_CHANNEL_ARN
    ? createKvsIceServerProvider({ channelArn: env.KVS_SIGNALING_CHANNEL_ARN })
    : undefined;

  return buildControlApi({
    inviteSecret,
    livekitMinter,
    auth,
    settings,
    egressStarter,
    streamKeyResolver,
    ...(iceServerProvider ? { iceServerProvider } : {}),
  });
}

/**
 * LiveKit Egress 起動アダプタを env から組み立てる (R12, ADR 0008 D-1)。
 *
 * LIVEKIT_SECRET_ARN から apiKey/apiSecret を取得し、livekitUrl は呼び出し時に
 * events.media.livekitUrl から渡される (per-event URL ルーティング)。
 * LIVEKIT_SECRET_ARN が無ければ undefined を返す。
 */
function resolveEgressStarter(
  env: NodeJS.ProcessEnv,
  secrets: SecretsResolver,
): EgressStarter | undefined {
  const livekitSecretArn = env.LIVEKIT_SECRET_ARN;
  if (!livekitSecretArn) return undefined;
  // P-14 / R14: 配信終了時に Egress が録画 mp4 を S3 アップロードする bucket。
  // 未設定なら stream 出力のみ (録画なし)。
  const recordingsBucketName = env.RECORDINGS_BUCKET_NAME;
  const recordingsRegion = env.AWS_REGION ?? "ap-northeast-1";
  return {
    async startRtmpEgress({ livekitUrl, roomName, streamUrl }) {
      const data = await secrets.getSecretJson(livekitSecretArn);
      const apiKey = data.apiKey;
      const apiSecret = data.apiSecret;
      if (!apiKey || !apiSecret) {
        throw new Error("LiveKit Secret に apiKey / apiSecret がない");
      }
      // wss:// は HTTP リクエスト用に https:// に変換する (LiveKit SDK の Twirp HTTP は https を使う)。
      const httpUrl = livekitUrl.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
      console.log(JSON.stringify({
        msg: "egress.startRtmpEgress",
        livekitUrl,
        httpUrl,
        roomName,
        streamUrl: streamUrl.replace(/\/[^/]+$/, "/***"), // streamKey 部分は伏字
        recordingsBucket: recordingsBucketName ?? "(not configured)",
      }));
      const sdk = await import("livekit-server-sdk");
      const client = new sdk.EgressClient(httpUrl, apiKey, apiSecret);
      try {
        // P-14 / R14: stream (RTMP → YouTube) と file (S3 録画) を併用する。
        // file output は recordingsBucketName が設定されている場合のみ。
        // P-14-followup-1: LiveKit Egress の filepath template に `{egress_id}` を渡すと
        // **plain literal でアップロードされる** (テンプレート展開されない) 問題を観測。
        // 公式に保証されたプレースホルダ (`{time}` 等) も使えるが、 Lambda 側で randomUUID を
        // 生成して filepath に埋め込む方が依存少なく確実。 LiveKit が返す egressId は startEgress
        // の戻り値ログに残るので、 manifest (`{egress_id}.json`) との紐付けは可能。
        // SFU TaskRole は ADR 0010 D-5 で `recordings/*` プレフィックスへの S3 PutObject 権限を持つ。
        const output: Record<string, unknown> = {
          stream: new sdk.StreamOutput({
            protocol: sdk.StreamProtocol.RTMP,
            urls: [streamUrl],
          }),
        };
        const recordingFileId = recordingsBucketName ? randomUUID() : undefined;
        if (recordingsBucketName && recordingFileId) {
          output.file = new sdk.EncodedFileOutput({
            filepath: `recordings/${roomName}/${recordingFileId}.mp4`,
            output: {
              case: "s3",
              value: new sdk.S3Upload({
                bucket: recordingsBucketName,
                region: recordingsRegion,
              }),
            },
          });
        }
        const info = await client.startRoomCompositeEgress(roomName, output, { layout: "grid" });
        console.log(
          JSON.stringify({
            msg: "egress.started",
            egressId: info.egressId,
            // P-14-followup-1: recordingFileId は admin-web の成果物一覧で表示される mp4 のファイル名。
            // LiveKit egressId とは別物だが、 同じ Egress ハンドルから生成されるので 1:1 対応する。
            recordingFileId: recordingFileId ?? "(no recording configured)",
          }),
        );
        return { egressId: info.egressId };
      } catch (err) {
        console.error(JSON.stringify({
          msg: "egress.failed",
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        }));
        throw err;
      }
    },
  };
}

/**
 * YouTube ストリームキー解決アダプタを env から組み立てる (R12)。
 * YOUTUBE_SECRET_ARN が無ければ undefined を返す。
 * `streamKeyRef` は Secret JSON のフィールド名 (例: `defaultStreamKey`)。
 */
function resolveStreamKeyResolver(
  env: NodeJS.ProcessEnv,
  secrets: SecretsResolver,
): StreamKeyResolver | undefined {
  const arn = env.YOUTUBE_SECRET_ARN;
  if (!arn) return undefined;
  return {
    async resolve(streamKeyRef) {
      const data = await secrets.getSecretJson(arn);
      const value = data[streamKeyRef];
      if (!value) {
        throw new Error(`stream key field '${streamKeyRef}' not found in YouTube secret`);
      }
      return value;
    },
  };
}

/**
 * 運用設定 (LiveKit / YouTube 認証情報) 管理を組み立てる。
 *
 * LIVEKIT_SECRET_ARN または YOUTUBE_SECRET_ARN のどちらか 1 つでもあれば SettingsService
 * を作る (片方しか env が無い環境でもサービスは部分的に利用できる)。両方無いなら
 * undefined を返し、HTTP 層が 503 を返す。
 */
function resolveSettings(
  env: NodeJS.ProcessEnv,
  reader: SecretsResolver,
  writer: SecretsWriter,
): SettingsService | undefined {
  const livekitSecretArn = env.LIVEKIT_SECRET_ARN;
  const youtubeSecretArn = env.YOUTUBE_SECRET_ARN;
  if (!livekitSecretArn && !youtubeSecretArn) return undefined;
  return createSettingsService({ reader, writer, livekitSecretArn, youtubeSecretArn });
}

async function resolveInviteSecret(
  env: NodeJS.ProcessEnv,
  secrets: SecretsResolver,
): Promise<string | undefined> {
  const arn = env.INVITE_TOKEN_SECRET_ARN;
  if (arn) {
    const data = await secrets.getSecretJson(arn);
    // 生成時のキー名は "secret" (CDK の generateSecretString.generateStringKey と一致)。
    const value = data.secret ?? data.value;
    if (!value) throw new Error(`invite token secret ${arn} has no usable field`);
    return value;
  }
  return env.INVITE_TOKEN_SECRET;
}

async function resolveLiveKit(
  env: NodeJS.ProcessEnv,
  secrets: SecretsResolver,
): Promise<LiveKitTokenMinter | undefined> {
  // ADR 0008 D-5: apiKey/apiSecret は全イベント共有。URL は per-event なので minter に持たせない。
  const arn = env.LIVEKIT_SECRET_ARN;
  if (arn) {
    const lk = await secrets.getSecretJson(arn);
    if (lk.apiKey && lk.apiSecret) {
      return new DefaultLiveKitTokenMinter({ apiKey: lk.apiKey, apiSecret: lk.apiSecret });
    }
    // 値未設定 (運用者が後で SettingsPage で生成する想定) なら minter を作らない。
    return undefined;
  }
  if (env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET) {
    return new DefaultLiveKitTokenMinter({
      apiKey: env.LIVEKIT_API_KEY,
      apiSecret: env.LIVEKIT_API_SECRET,
    });
  }
  return undefined;
}

function resolveAdminAuth(env: NodeJS.ProcessEnv): AdminAuthVerifier {
  if (env.COGNITO_USER_POOL_ID && env.COGNITO_USER_POOL_CLIENT_ID) {
    return cognitoAdminAuthVerifier({
      userPoolId: env.COGNITO_USER_POOL_ID,
      clientId: env.COGNITO_USER_POOL_CLIENT_ID,
    });
  }
  return new FakeAdminAuthVerifier();
}
