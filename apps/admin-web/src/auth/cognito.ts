/**
 * Cognito Hosted UI (OAuth Authorization Code + PKCE) クライアント (T6, F-12)。
 *
 * 公開クライアントに safely 適用できる Authorization Code + PKCE フローで Cognito の
 * Hosted UI と連携する。client_secret を持たないため SPA に埋め込める。
 *
 * 仕様: https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-userpools-server-contract-reference.html
 */

export interface CognitoAuthConfig {
  /** Cognito ドメイン (例: stagecast-admin-123456789012.auth.us-east-1.amazoncognito.com) */
  domain: string;
  /** App client ID (Cognito User Pool Client) */
  clientId: string;
  /** OAuth コールバック URL (Cognito に登録済みのもの) */
  redirectUri: string;
  /** ログアウト後の遷移先 (Cognito に登録済みのもの) */
  logoutUri: string;
  /** リクエストスコープ (既定: openid email profile) */
  scopes?: string[];
}

export interface TokenSet {
  idToken: string;
  accessToken: string;
  /** UNIX ms。期限切れの判定に使う。 */
  expiresAtMs: number;
}

const STORAGE_KEYS = {
  pkceVerifier: "stagecast.auth.pkce.verifier",
  oauthState: "stagecast.auth.oauth.state",
  idToken: "stagecast.idToken",
  accessToken: "stagecast.accessToken",
  expiresAt: "stagecast.expiresAt",
} as const;

/** URL-safe Base64 (RFC 7636 §4.1)。Buffer 非依存 (ブラウザ前提)。 */
function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of u8) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function createPkceChallenge(): Promise<{ verifier: string; challenge: string }> {
  // RFC 7636 §4.1: 43–128 chars unreserved。32 bytes ランダム → base64url で 43 chars。
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64UrlEncode(verifierBytes);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(hash);
  return { verifier, challenge };
}

export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class CognitoAuthClient {
  private readonly scopes: string;

  constructor(
    private readonly config: CognitoAuthConfig,
    private readonly storage: SessionStorageLike = globalThis.sessionStorage,
  ) {
    this.scopes = (config.scopes ?? ["openid", "email", "profile"]).join(" ");
  }

  /** Hosted UI のログインページへ遷移するための URL を構築する。 */
  async buildLoginUrl(): Promise<string> {
    const { verifier, challenge } = await createPkceChallenge();
    const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
    this.storage.setItem(STORAGE_KEYS.pkceVerifier, verifier);
    this.storage.setItem(STORAGE_KEYS.oauthState, state);
    const url = new URL(`https://${this.config.domain}/oauth2/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("scope", this.scopes);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  /** Callback URL に含まれる code/state を検証し、トークンを取得する。 */
  async exchangeCode(code: string, state: string): Promise<TokenSet> {
    const expectedState = this.storage.getItem(STORAGE_KEYS.oauthState);
    if (!expectedState || state !== expectedState) {
      throw new Error("oauth state mismatch (CSRF protection)");
    }
    const verifier = this.storage.getItem(STORAGE_KEYS.pkceVerifier);
    if (!verifier) throw new Error("pkce verifier missing (login flow not initiated)");
    // 使い終わったら消す。再利用は CSRF/コード再生攻撃の入口になる。
    this.storage.removeItem(STORAGE_KEYS.oauthState);
    this.storage.removeItem(STORAGE_KEYS.pkceVerifier);

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.config.clientId,
      code,
      redirect_uri: this.config.redirectUri,
      code_verifier: verifier,
    });
    const res = await fetch(`https://${this.config.domain}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`token exchange failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as {
      id_token: string;
      access_token: string;
      expires_in: number;
    };
    const tokens: TokenSet = {
      idToken: data.id_token,
      accessToken: data.access_token,
      expiresAtMs: Date.now() + data.expires_in * 1000,
    };
    this.saveTokens(tokens);
    return tokens;
  }

  /** 保存済みトークンを読み出す。期限切れなら undefined。 */
  getTokens(): TokenSet | undefined {
    const idToken = this.storage.getItem(STORAGE_KEYS.idToken);
    const accessToken = this.storage.getItem(STORAGE_KEYS.accessToken);
    const expiresAt = this.storage.getItem(STORAGE_KEYS.expiresAt);
    if (!idToken || !accessToken || !expiresAt) return undefined;
    const expiresAtMs = Number(expiresAt);
    if (Number.isNaN(expiresAtMs) || Date.now() >= expiresAtMs) return undefined;
    return { idToken, accessToken, expiresAtMs };
  }

  /** トークンを保存する。 */
  saveTokens(tokens: TokenSet): void {
    this.storage.setItem(STORAGE_KEYS.idToken, tokens.idToken);
    this.storage.setItem(STORAGE_KEYS.accessToken, tokens.accessToken);
    this.storage.setItem(STORAGE_KEYS.expiresAt, String(tokens.expiresAtMs));
  }

  /** Cognito Hosted UI のログアウト URL を返す (ブラウザはここへ遷移してセッションを切る)。 */
  buildLogoutUrl(): string {
    const url = new URL(`https://${this.config.domain}/logout`);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("logout_uri", this.config.logoutUri);
    return url.toString();
  }

  /** ローカル保存トークンを破棄する。 */
  clearTokens(): void {
    this.storage.removeItem(STORAGE_KEYS.idToken);
    this.storage.removeItem(STORAGE_KEYS.accessToken);
    this.storage.removeItem(STORAGE_KEYS.expiresAt);
  }
}

/**
 * ドメイン/クライアントIDから CognitoAuthConfig を組み立てる。
 * redirect/logout URI は実行時の `window.location.origin` (= CloudFront ドメイン) から導出するので、
 * ランタイム設定 (config.json) にはドメインとクライアントIDだけ持てばよい。
 */
export function cognitoConfig(base: { domain: string; clientId: string }): CognitoAuthConfig {
  const origin = globalThis.location?.origin ?? "";
  return {
    domain: base.domain,
    clientId: base.clientId,
    redirectUri: `${origin}/auth/callback`,
    logoutUri: `${origin}/`,
  };
}
