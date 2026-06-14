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
  constructor(message = 'unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * テスト/ローカル用のフェイク検証器。
 * `Bearer fake:<userId>:<email>` 形式を受け付ける。本番では使用しない。
 */
export class FakeAdminAuthVerifier implements AdminAuthVerifier {
  async verify(authorizationHeader: string | undefined): Promise<AdminPrincipal> {
    const token = authorizationHeader?.replace(/^Bearer\s+/i, '');
    if (!token || !token.startsWith('fake:')) throw new UnauthorizedError();
    const [, userId, email] = token.split(':');
    if (!userId) throw new UnauthorizedError();
    return { userId, email };
  }
}
