/**
 * 管理者認証 (DESIGN.md 4 表, F-12)。
 *
 * 管理者は Cognito で認証する。本番では API Gateway の Cognito JWT オーソライザ、
 * または JWKS による ID トークン検証を用いる。テスト/ローカルではフェイク検証器に
 * 差し替えて外部接続なしに動かす。
 */
export interface AdminPrincipal {
  /** Cognito sub。 */
  userId: string;
  email?: string;
}

export interface AdminAuthVerifier {
  /** Authorization ヘッダ (Bearer トークン) を検証し、管理者プリンシパルを返す。 */
  verify(authorizationHeader: string | undefined): Promise<AdminPrincipal>;
}

export class UnauthorizedError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * テスト/ローカル用のフェイク検証器。
 * `Bearer fake:<userId>:<email>` 形式を受け付ける。本番では使用しない。
 */
export class FakeAdminAuthVerifier implements AdminAuthVerifier {
  async verify(authorizationHeader: string | undefined): Promise<AdminPrincipal> {
    const token = authorizationHeader?.replace(/^Bearer\s+/i, "");
    if (!token || !token.startsWith("fake:")) throw new UnauthorizedError();
    const [, userId, email] = token.split(":");
    if (!userId) throw new UnauthorizedError();
    return { userId, email };
  }
}

/** 検証済み JWT クレーム (Cognito の最小サブセット)。 */
export interface VerifiedJwtClaims {
  sub: string;
  email?: string;
}

/**
 * Cognito JWT による管理者認証 (DESIGN.md 4 表, F-12)。
 *
 * 実際の JWT 検証 (JWKS・署名・aud/iss・有効期限) は注入された verify 関数に委ねる。
 * 本番では aws-jwt-verify の CognitoJwtVerifier から構築し (cognitoAdminAuthVerifier)、
 * テストではフェイク verify を注入して外部接続なしに分岐を検証する。
 */
export class CognitoJwtAdminAuthVerifier implements AdminAuthVerifier {
  constructor(private readonly verifyJwt: (token: string) => Promise<VerifiedJwtClaims>) {}

  async verify(authorizationHeader: string | undefined): Promise<AdminPrincipal> {
    const token = authorizationHeader?.replace(/^Bearer\s+/i, "");
    if (!token) throw new UnauthorizedError("missing bearer token");
    try {
      const claims = await this.verifyJwt(token);
      return { userId: claims.sub, email: claims.email };
    } catch {
      throw new UnauthorizedError("invalid token");
    }
  }
}

/**
 * 本番用ファクトリ。aws-jwt-verify を遅延 import して CognitoJwtVerifier を構築する。
 * (依存を実行時に解決し、テスト/ローカルでは未使用にできる。)
 */
export function cognitoAdminAuthVerifier(config: {
  userPoolId: string;
  clientId: string;
}): CognitoJwtAdminAuthVerifier {
  let verifier: { verify: (token: string) => Promise<VerifiedJwtClaims> } | undefined;
  const verifyJwt = async (token: string): Promise<VerifiedJwtClaims> => {
    if (!verifier) {
      const { CognitoJwtVerifier } = await import("aws-jwt-verify");
      verifier = CognitoJwtVerifier.create({
        userPoolId: config.userPoolId,
        clientId: config.clientId,
        tokenUse: "id",
      }) as unknown as { verify: (token: string) => Promise<VerifiedJwtClaims> };
    }
    return verifier.verify(token);
  };
  return new CognitoJwtAdminAuthVerifier(verifyJwt);
}
