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
}

export function parseAdminDirectParams(search: string): AdminDirectParams | undefined {
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  const token = params.get("token");
  const url = params.get("url");
  const eventId = params.get("eventId");
  if (token && url && eventId) {
    return { livekitToken: token, livekitUrl: url, eventId };
  }
  return undefined;
}
