/**
 * 制御層の運用設定 (LiveKit / YouTube 認証情報) 管理 (ADR D-10)。
 *
 * 機密値は Secrets Manager に保存する。GET は configured フラグと
 * 非機密のメタ情報 (LiveKit の URL) だけを返し、PUT は全フィールド必須の
 * 完全置き換え (部分更新は許可しない) で衝突や意図しない上書きを防ぐ。
 */
import { randomBytes } from "node:crypto";
import type {
  LiveKitCredentials,
  LiveKitSettingsStatus,
  YouTubeCredentials,
  YouTubeSettingsStatus,
} from "@stagecast/shared";
import { ValidationError } from "./events.js";

/** Secrets Manager の最小読み取り操作 (lambda.ts の SecretsResolver と互換)。 */
export interface SecretsReader {
  getSecretJson(secretId: string): Promise<Record<string, string>>;
}

/** Secrets Manager の書き込み操作。テストでは fake を注入する。 */
export interface SecretsWriter {
  putSecretJson(secretId: string, payload: Record<string, string>): Promise<void>;
}

export interface SettingsServiceDeps {
  reader: SecretsReader;
  writer: SecretsWriter;
  /** Secret ARN (CDK が env で渡す)。未設定なら 503 相当の挙動を呼び出し側で扱う。 */
  livekitSecretArn?: string;
  youtubeSecretArn?: string;
}

export type SettingsService = ReturnType<typeof createSettingsService>;

const LIVEKIT_FIELDS: ReadonlyArray<keyof LiveKitCredentials> = ["url", "apiKey", "apiSecret"];
const YOUTUBE_FIELDS: ReadonlyArray<keyof YouTubeCredentials> = [
  "apiKey",
  "oauthClientId",
  "oauthClientSecret",
];

function requireString(field: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError(`${field} is required`);
  }
  return value;
}

function validateLiveKitUrl(url: string): string {
  // wss:// または ws:// で始まる URL のみ許可 (LiveKit のシグナリング)。
  // localhost 開発のため ws:// も許す。
  try {
    const u = new URL(url);
    if (u.protocol !== "wss:" && u.protocol !== "ws:") {
      throw new ValidationError("url must use wss:// or ws://");
    }
    return url;
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError("url is not a valid URL");
  }
}

function parseLiveKitInput(body: unknown): LiveKitCredentials {
  const b = (body ?? {}) as Record<string, unknown>;
  const url = validateLiveKitUrl(requireString("url", b.url));
  const apiKey = requireString("apiKey", b.apiKey);
  const apiSecret = requireString("apiSecret", b.apiSecret);
  return { url, apiKey, apiSecret };
}

function parseYouTubeInput(body: unknown): YouTubeCredentials {
  const b = (body ?? {}) as Record<string, unknown>;
  const apiKey = requireString("apiKey", b.apiKey);
  const oauthClientId = requireString("oauthClientId", b.oauthClientId);
  const oauthClientSecret = requireString("oauthClientSecret", b.oauthClientSecret);
  return { apiKey, oauthClientId, oauthClientSecret };
}

function allFieldsPresent<T extends string>(
  data: Record<string, string>,
  fields: ReadonlyArray<T>,
): boolean {
  return fields.every((f) => typeof data[f] === "string" && data[f]!.length > 0);
}

export function createSettingsService(deps: SettingsServiceDeps) {
  const { reader, writer, livekitSecretArn, youtubeSecretArn } = deps;

  function requireLiveKitArn(): string {
    if (!livekitSecretArn) throw new ValidationError("LIVEKIT_SECRET_ARN not configured");
    return livekitSecretArn;
  }
  function requireYouTubeArn(): string {
    if (!youtubeSecretArn) throw new ValidationError("YOUTUBE_SECRET_ARN not configured");
    return youtubeSecretArn;
  }

  async function getLiveKit(): Promise<LiveKitSettingsStatus> {
    const arn = requireLiveKitArn();
    const data = await reader.getSecretJson(arn);
    const configured = allFieldsPresent(data, LIVEKIT_FIELDS);
    return configured && data.url ? { configured, url: data.url } : { configured };
  }

  async function putLiveKit(body: unknown): Promise<LiveKitSettingsStatus> {
    const arn = requireLiveKitArn();
    const creds = parseLiveKitInput(body);
    await writer.putSecretJson(arn, { ...creds });
    return { configured: true, url: creds.url };
  }

  /**
   * URL のみを更新する (API キー/シークレットは保持)。
   * self-hosted で EventMediaStack の NLB DNS が後から決まる運用向け。
   * 既存の鍵が無い場合は configured:false のままだが、URL は保存される。
   */
  async function patchLiveKitUrl(body: unknown): Promise<LiveKitSettingsStatus> {
    const arn = requireLiveKitArn();
    const b = (body ?? {}) as Record<string, unknown>;
    const url = validateLiveKitUrl(requireString("url", b.url));
    const current = await reader.getSecretJson(arn);
    const apiKey = typeof current.apiKey === "string" ? current.apiKey : "";
    const apiSecret = typeof current.apiSecret === "string" ? current.apiSecret : "";
    await writer.putSecretJson(arn, { url, apiKey, apiSecret });
    const configured = apiKey.length > 0 && apiSecret.length > 0;
    return configured ? { configured, url } : { configured };
  }

  /**
   * LiveKit の API キー/シークレットをサーバ側で再生成し Secret に保存する (URL は保持)。
   *
   * 鍵は `crypto.randomBytes` で生成し、apiKey は LiveKit 慣習に従い `API` prefix +
   * 12 文字 (URL-safe base64)、apiSecret は 32 バイト (256 bit) ぶんの URL-safe base64
   * (43 文字) を採用する。生成値はレスポンスに含めない (configured / url のみ返す):
   * 値は Secrets Manager から ECS Secret / Lambda env として注入される (ADR 0006 D-3)。
   */
  async function regenerateLiveKit(): Promise<LiveKitSettingsStatus> {
    const arn = requireLiveKitArn();
    const current = await reader.getSecretJson(arn);
    const url = typeof current.url === "string" ? current.url : "";
    const apiKey = generateLiveKitApiKey();
    const apiSecret = generateLiveKitApiSecret();
    await writer.putSecretJson(arn, { url, apiKey, apiSecret });
    const configured = url.length > 0 && apiKey.length > 0 && apiSecret.length > 0;
    return configured ? { configured, url } : { configured };
  }

  async function getYouTube(): Promise<YouTubeSettingsStatus> {
    const arn = requireYouTubeArn();
    const data = await reader.getSecretJson(arn);
    return { configured: allFieldsPresent(data, YOUTUBE_FIELDS) };
  }

  async function putYouTube(body: unknown): Promise<YouTubeSettingsStatus> {
    const arn = requireYouTubeArn();
    const creds = parseYouTubeInput(body);
    await writer.putSecretJson(arn, { ...creds });
    return { configured: true };
  }

  return {
    getLiveKit,
    putLiveKit,
    patchLiveKitUrl,
    regenerateLiveKit,
    getYouTube,
    putYouTube,
  };
}

/** LiveKit 慣習: `API` + 12 文字 URL-safe base64。識別子として人にも読める。 */
function generateLiveKitApiKey(): string {
  // 9 bytes → base64url 12 chars (パディング不要長さに揃う)。
  return "API" + randomBytes(9).toString("base64url");
}

/** 256 bit のエントロピーで apiSecret を作る。base64url 43 文字 (パディング無し)。 */
function generateLiveKitApiSecret(): string {
  return randomBytes(32).toString("base64url");
}
