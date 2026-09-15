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
  /** id/access token の更新に使う (Cognito 既定 30 日)。発行されない構成もあるので optional。 */
  refreshToken?: string;
}

const STORAGE_KEYS = {
  pkceVerifier: "stagecast.auth.pkce.verifier",
  oauthState: "stagecast.auth.oauth.state",
  idToken: "stagecast.idToken",
  accessToken: "stagecast.accessToken",
  expiresAt: "stagecast.expiresAt",
  refreshToken: "stagecast.refreshToken",
} as const;

/**
 * トークン取得の結果 (D11)。
 * 「セッションが終わった」と「今は更新できない」を呼び出し側が区別できるようにする。
 * 両者を undefined にまとめると、通信が一瞬切れただけでログイン画面に飛ばしてしまう。
 */
export type TokenLookup =
  /** 使えるトークンがある。 */
  | { status: "ok"; tokens: TokenSet }
  /** refresh token が無い/失効した。再ログインが必要。 */
  | { status: "expired" }
  /** 一時的に更新できない (通信断・Cognito 側の障害)。セッション自体は生きている可能性がある。 */
  | { status: "unavailable" };

/**
 * 期限切れの何 ms 前から更新をかけるか (D11)。
 * 更新の往復と、その間に飛ぶ API 呼び出しが期限内に収まるだけの余裕を取る。
 */
const REFRESH_LEAD_MS = 5 * 60 * 1000;

/**
 * 更新に失敗してから次に試すまでの間隔 (D11)。
 * リード時間中は API 呼び出しのたびに更新条件を満たすので、これが無いと通信断のあいだ
 * 3 つの HTTP クライアント + ポーリングが無制限に /oauth2/token を叩き、429 を招く。
 */
const REFRESH_RETRY_COOLDOWN_MS = 30 * 1000;

/** 一時的な失敗として扱う HTTP ステータス (retry-able)。これ以外の 4xx は失効とみなす。 */
const RETRYABLE_STATUSES = new Set([408, 429]);

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
  private refreshInFlight?: Promise<TokenLookup>;
  /** clearTokens のたびに進む。更新の応答が古い世代のものかを判定する (ログアウト競合対策)。 */
  private tokenEpoch = 0;
  /** この時刻までは更新を再試行しない (UNIX ms)。 */
  private retryAfterMs = 0;

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
    const tokens = parseTokenResponse(await res.json());
    if (!tokens) throw new Error("token exchange returned an unexpected payload");
    // saveTokens は refresh token を「渡されたときだけ」書くので、ログインし直しで
    // 前のセッションのものが残らないよう先に消しておく。
    this.storage.removeItem(STORAGE_KEYS.refreshToken);
    this.saveTokens(tokens);
    return tokens;
  }

  /**
   * 期限に余裕があるトークンを返す。残りが REFRESH_LEAD_MS を切っていれば更新を試みる (D11)。
   * 更新できなくても、原因が一時的なもの (通信断など) なら "expired" にはしない。
   */
  async getValidToken(): Promise<TokenLookup> {
    const current = this.getTokens();
    if (current && Date.now() < current.expiresAtMs - REFRESH_LEAD_MS) {
      return { status: "ok", tokens: current };
    }
    const result = await this.refreshTokens();
    if (result.status === "ok") return result;
    // 一時的に更新できないだけなら、期限内の現行トークンで粘る (通信断で作業を止めない)。
    // "expired" のときは current を返さない -- 失効時に clearTokens() 済みなので、
    // 消したはずのトークンを「まだ使える」と返してしまう。
    if (result.status === "unavailable" && current) return { status: "ok", tokens: current };
    return result;
  }

  /**
   * refresh token で id/access token を更新する。
   * 画面から複数の API 呼び出しが同時に走っても更新は 1 回に畳む (single-flight)。
   */
  async refreshTokens(): Promise<TokenLookup> {
    this.refreshInFlight ??= this.requestRefresh()
      // 呼び出し側は結果だけ見れば済むようにする。予期しない例外で認証判定ごと落とさない。
      .catch((): TokenLookup => ({ status: "unavailable" }))
      .finally(() => {
        this.refreshInFlight = undefined;
      });
    return this.refreshInFlight;
  }

  private async requestRefresh(): Promise<TokenLookup> {
    const refreshToken = this.storage.getItem(STORAGE_KEYS.refreshToken);
    if (!refreshToken) return { status: "expired" };
    // 直前に失敗していれば間隔を空ける。ここで弾いた分は現行トークンで粘る側に倒れる。
    if (Date.now() < this.retryAfterMs) return { status: "unavailable" };
    // 応答が返るころに logout 等でトークンが消えていたら、保存し直してはいけない。
    const epoch = this.tokenEpoch;
    // PKCE は authorization_code 側だけの話なので code_verifier も redirect_uri も要らない。
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.config.clientId,
      refresh_token: refreshToken,
    });
    let res: Response;
    try {
      res = await fetch(`https://${this.config.domain}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch {
      // ネットワーク断はトークンを捨てる理由にならない。間隔を空けて再試行する。
      return this.failTemporarily();
    }
    if (!res.ok) {
      // 5xx は Cognito 側の一時障害、408/429 は混雑。どちらも refresh token は生きている。
      if (res.status >= 500 || RETRYABLE_STATUSES.has(res.status)) return this.failTemporarily();
      // 残りの 4xx (invalid_grant 等) は失効/取り消し済み。持っていても無駄なので捨てる。
      this.clearTokens();
      return { status: "expired" };
    }
    const tokens = parseTokenResponse(await res.json(), refreshToken);
    // 200 でも中身が期待と違えば保存しない。壊れた値で正常なトークンを上書きしてしまう。
    if (!tokens) return this.failTemporarily();
    // logout や失効を挟んでいたら、この応答はもう古い世代のもの。
    if (epoch !== this.tokenEpoch) return { status: "expired" };
    this.retryAfterMs = 0;
    this.saveTokens(tokens);
    return { status: "ok", tokens };
  }

  /** 保存済みトークンを読み出す。期限切れなら undefined。 */
  getTokens(): TokenSet | undefined {
    const idToken = this.storage.getItem(STORAGE_KEYS.idToken);
    const accessToken = this.storage.getItem(STORAGE_KEYS.accessToken);
    const expiresAt = this.storage.getItem(STORAGE_KEYS.expiresAt);
    if (!idToken || !accessToken || !expiresAt) return undefined;
    const expiresAtMs = Number(expiresAt);
    if (Number.isNaN(expiresAtMs) || Date.now() >= expiresAtMs) return undefined;
    const refreshToken = this.storage.getItem(STORAGE_KEYS.refreshToken) ?? undefined;
    return { idToken, accessToken, expiresAtMs, refreshToken };
  }

  /** トークンを保存する。 */
  saveTokens(tokens: TokenSet): void {
    this.storage.setItem(STORAGE_KEYS.idToken, tokens.idToken);
    this.storage.setItem(STORAGE_KEYS.accessToken, tokens.accessToken);
    this.storage.setItem(STORAGE_KEYS.expiresAt, String(tokens.expiresAtMs));
    // 更新応答には refresh token が無いので、渡されたときだけ上書きして既存を消さない。
    if (tokens.refreshToken) {
      this.storage.setItem(STORAGE_KEYS.refreshToken, tokens.refreshToken);
    }
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
    this.storage.removeItem(STORAGE_KEYS.refreshToken);
    // 進行中の更新がこの後に応答を返しても、保存させない (ログアウト競合対策)。
    this.tokenEpoch += 1;
  }

  /** 一時的な失敗として記録する。次の試行までは間隔を空ける。 */
  private failTemporarily(): TokenLookup {
    this.retryAfterMs = Date.now() + REFRESH_RETRY_COOLDOWN_MS;
    return { status: "unavailable" };
  }
}

/**
 * token エンドポイントの応答を検証して TokenSet にする。期待と違う形なら undefined。
 * 素のキャストだと id_token が無い応答で "undefined" や NaN を保存してしまう。
 */
function parseTokenResponse(payload: unknown, fallbackRefreshToken?: string): TokenSet | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const data = payload as Record<string, unknown>;
  const { id_token: idToken, access_token: accessToken, expires_in: expiresIn } = data;
  if (typeof idToken !== "string" || idToken === "") return undefined;
  if (typeof accessToken !== "string" || accessToken === "") return undefined;
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return undefined;
  }
  const refreshToken = data["refresh_token"];
  return {
    idToken,
    accessToken,
    expiresAtMs: Date.now() + expiresIn * 1000,
    // Cognito は refresh 応答に refresh_token を含めない (既存のものを使い続ける) ので持ち越す。
    refreshToken: typeof refreshToken === "string" ? refreshToken : fallbackRefreshToken,
  };
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
