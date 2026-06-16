/**
 * Lambda 起動時の依存解決 (Secrets Manager / Cognito) (T5, T7, ADR D-10)。
 *
 * 同期の `buildControlApi` (factory) はテスト/ローカルで使う。Lambda では
 * 招待トークン秘密鍵 / LiveKit 鍵を Secrets Manager から非同期に取得し、
 * Cognito User Pool 設定があれば JWT 検証器を組み立てて差し込む。
 *
 * 秘密値は cold start で 1 回だけ取得し、warm 中はキャッシュする。
 */
import {
  cognitoAdminAuthVerifier,
  FakeAdminAuthVerifier,
  type AdminAuthVerifier,
} from "./auth/admin-auth.js";
import { DefaultLiveKitTokenMinter, type LiveKitTokenMinter } from "./auth/livekit-minter.js";
import { buildControlApi } from "./factory.js";
import type { App } from "./http/app.js";
import {
  createSettingsService,
  type SecretsWriter,
  type SettingsService,
} from "./usecases/settings.js";

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

  return buildControlApi({
    inviteSecret,
    livekitMinter,
    auth,
    settings,
  });
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
