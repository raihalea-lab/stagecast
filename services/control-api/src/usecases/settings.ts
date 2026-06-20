/**
 * 制御層の運用設定 (LiveKit / YouTube 認証情報) 管理 (ADR D-10, ADR 0008 D-7)。
 *
 * 機密値は Secrets Manager に保存する。GET は configured フラグのみ返し (機密値は読み戻さない)、
 * PUT は全フィールド必須の完全置き換え。
 *
 * LiveKit の URL は per-event 化 (ADR 0008) により events.media.livekitUrl で管理される。
 * ここで扱うのは全イベント共有の apiKey/apiSecret のみ。
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

const LIVEKIT_FIELDS: ReadonlyArray<keyof LiveKitCredentials> = ["apiKey", "apiSecret"];
/** YouTube の OAuth/API 設定 (`configured` 判定対象)。streamKey は別系統で判定する (R12)。 */
const YOUTUBE_OAUTH_FIELDS = [
  "apiKey",
  "oauthClientId",
  "oauthClientSecret",
] as const;
/** ストリームキーのフィールド名 (Secret 内で R12 が参照する `streamKeyRef`)。 */
const YOUTUBE_STREAM_KEY_FIELD = "streamKey";

function requireString(field: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError(`${field} is required`);
  }
  return value;
}

function parseLiveKitInput(body: unknown): LiveKitCredentials {
  const b = (body ?? {}) as Record<string, unknown>;
  const apiKey = requireString("apiKey", b.apiKey);
  const apiSecret = requireString("apiSecret", b.apiSecret);
  return { apiKey, apiSecret };
}

/**
 * YouTube 設定入力をパースする (差分更新, R12)。
 * 指定されたフィールドのみ返す。1 つも指定がなければ ValidationError。
 */
function parseYouTubeInput(body: unknown): YouTubeCredentials {
  const b = (body ?? {}) as Record<string, unknown>;
  const result: YouTubeCredentials = {};
  if (b.apiKey !== undefined) result.apiKey = requireString("apiKey", b.apiKey);
  if (b.oauthClientId !== undefined)
    result.oauthClientId = requireString("oauthClientId", b.oauthClientId);
  if (b.oauthClientSecret !== undefined)
    result.oauthClientSecret = requireString("oauthClientSecret", b.oauthClientSecret);
  if (b.streamKey !== undefined) result.streamKey = requireString("streamKey", b.streamKey);
  if (Object.keys(result).length === 0) {
    throw new ValidationError("at least one of apiKey/oauthClientId/oauthClientSecret/streamKey is required");
  }
  return result;
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
    return { configured: allFieldsPresent(data, LIVEKIT_FIELDS) };
  }

  async function putLiveKit(body: unknown): Promise<LiveKitSettingsStatus> {
    const arn = requireLiveKitArn();
    const creds = parseLiveKitInput(body);
    // livekitKeys: LiveKit Server が LIVEKIT_KEYS env として読む "key: secret" 形式。
    const livekitKeys = `${creds.apiKey}: ${creds.apiSecret}`;
    await writer.putSecretJson(arn, { ...creds, livekitKeys });
    return { configured: true };
  }

  /**
   * LiveKit の API キー/シークレットをサーバ側で再生成し Secret に保存する。
   *
   * 鍵は `crypto.randomBytes` で生成し、apiKey は LiveKit 慣習に従い `API` prefix +
   * 12 文字 (URL-safe base64)、apiSecret は 32 バイト (256 bit) ぶんの URL-safe base64
   * (43 文字) を採用する。生成値はレスポンスに含めない (configured のみ返す):
   * 値は Secrets Manager から ECS Secret / Lambda env として注入される (ADR 0006 D-3)。
   */
  async function regenerateLiveKit(): Promise<LiveKitSettingsStatus> {
    const arn = requireLiveKitArn();
    const apiKey = generateLiveKitApiKey();
    const apiSecret = generateLiveKitApiSecret();
    // livekitKeys: LiveKit Server が LIVEKIT_KEYS env として読む "key: secret" 形式。
    const livekitKeys = `${apiKey}: ${apiSecret}`;
    await writer.putSecretJson(arn, { apiKey, apiSecret, livekitKeys });
    return { configured: true };
  }

  async function getYouTube(): Promise<YouTubeSettingsStatus> {
    const arn = requireYouTubeArn();
    const data = await reader.getSecretJson(arn);
    return {
      configured: allFieldsPresent(data, YOUTUBE_OAUTH_FIELDS),
      streamKeyConfigured:
        typeof data[YOUTUBE_STREAM_KEY_FIELD] === "string" &&
        data[YOUTUBE_STREAM_KEY_FIELD]!.length > 0,
    };
  }

  /**
   * YouTube 設定を差分更新する (R12)。
   * 指定されたフィールドだけを書き換え、既存値はそのまま保持する。
   * Secrets Manager は PUT で全体置換しか出来ないため、まず現値を読んで merge する。
   */
  async function putYouTube(body: unknown): Promise<YouTubeSettingsStatus> {
    const arn = requireYouTubeArn();
    const patch = parseYouTubeInput(body);
    const current = await reader.getSecretJson(arn).catch(() => ({}) as Record<string, string>);
    const merged: Record<string, string> = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      if (typeof v === "string") merged[k] = v;
    }
    await writer.putSecretJson(arn, merged);
    return {
      configured: allFieldsPresent(merged, YOUTUBE_OAUTH_FIELDS),
      streamKeyConfigured:
        typeof merged[YOUTUBE_STREAM_KEY_FIELD] === "string" &&
        merged[YOUTUBE_STREAM_KEY_FIELD]!.length > 0,
    };
  }

  return {
    getLiveKit,
    putLiveKit,
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
