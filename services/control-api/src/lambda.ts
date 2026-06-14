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

/** Secrets Manager の最小操作。テストでは fake を注入する。 */
export interface SecretsResolver {
  getSecretJson(secretId: string): Promise<Record<string, string>>;
}

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

export interface BuildFromEnvOptions {
  /** Secrets Manager 解決器 (テストでは fake を注入)。 */
  secrets?: SecretsResolver;
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

  const inviteSecret = await resolveInviteSecret(env, secrets);
  const livekitMinter = await resolveLiveKit(env, secrets);
  const auth = resolveAdminAuth(env);

  return buildControlApi({
    inviteSecret,
    livekitMinter,
    auth,
  });
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
  const arn = env.LIVEKIT_SECRET_ARN;
  if (arn) {
    const lk = await secrets.getSecretJson(arn);
    if (lk.url && lk.apiKey && lk.apiSecret) {
      return new DefaultLiveKitTokenMinter({
        url: lk.url,
        apiKey: lk.apiKey,
        apiSecret: lk.apiSecret,
      });
    }
    // 値未設定 (運用者が後で更新する想定) なら minter を作らない。
    return undefined;
  }
  if (env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET) {
    return new DefaultLiveKitTokenMinter({
      url: env.LIVEKIT_URL,
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
