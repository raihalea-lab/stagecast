/**
 * 招待 URL からトークンを取り出す (DESIGN.md 4.1)。
 * 例: https://stage.example.com/?token=xxxx
 */
export function parseInviteToken(search: string): string | undefined {
  const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
  const token = params.get('token');
  return token ?? undefined;
}
