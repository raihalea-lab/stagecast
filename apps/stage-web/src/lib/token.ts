/**
 * 招待 URL からトークンを取り出す (DESIGN.md 4.1)。
 * 例: https://stage.example.com/?token=xxxx
 */
export function parseInviteToken(search: string): string | undefined {
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  const token = params.get("token");
  return token ?? undefined;
}

/**
 * Admin 直接接続用パラメータ (ADR 0014 D-4)。
 * OpenStageButton が `?token=<lk-token>&url=<lk-url>&eventId=<id>` で開く。
 */
export interface AdminDirectParams {
  livekitToken: string;
  livekitUrl: string;
  eventId: string;
  /**
   * プレビュー iframe 用の viewer token。 Lambda が旧版だと来ないので optional。
   * 無いときはプレビューを出さない — livekitToken で代用すると identity が重複して
   * 親ページが LiveKit に切断される。
   */
  previewToken?: string;
  /**
   * `/stage/*` を叩くための招待トークン (ADR 0025 D-3)。 旧 Lambda では来ないので optional。
   * 無いときは admin はプリセット・アセットをローカル限定で扱う (従来の挙動)。
   */
  inviteToken?: string;
}

export function parseAdminDirectParams(search: string): AdminDirectParams | undefined {
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  const token = params.get("token");
  const url = params.get("url");
  const eventId = params.get("eventId");
  if (token && url && eventId) {
    const previewToken = params.get("previewToken");
    const inviteToken = params.get("inviteToken");
    return {
      livekitToken: token,
      livekitUrl: url,
      eventId,
      ...(previewToken ? { previewToken } : {}),
      ...(inviteToken ? { inviteToken } : {}),
    };
  }
  return undefined;
}
