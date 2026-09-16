/**
 * 翻訳参考資料の登録 API クライアント (ADR 0021 D-1)。
 *
 * イベント準備の段階で資料 (PDF・PPTX・原稿) を登録しておくと、抽出 Lambda が
 * テキストを取り出し、字幕ワーカーが翻訳の文脈として使う。
 */

/** 登録済みの資料 1 件。 */
export interface MaterialItem {
  assetId: string;
  filename: string;
  key: string;
}

/** 翻訳参考資料として登録できる形式 (control-api の許可リストと対応させる)。 */
export const MATERIAL_ACCEPT = ".pdf,.pptx,.md,.txt";

/** 拡張子から content-type を決める。control-api 側で拡張子との一致も検証される。 */
export function materialContentType(filename: string): string | undefined {
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case "md":
      return "text/markdown";
    case "txt":
      return "text/plain";
    default:
      return undefined;
  }
}

export interface MaterialsService {
  list(eventId: string): Promise<MaterialItem[]>;
  upload(eventId: string, file: File): Promise<void>;
  remove(eventId: string, assetId: string): Promise<void>;
}

export class HttpMaterialsService implements MaterialsService {
  constructor(
    private readonly baseUrl: string,
    private readonly getToken: () => string | undefined,
  ) {}

  private authHeaders(): Record<string, string> {
    const token = this.getToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  async list(eventId: string): Promise<MaterialItem[]> {
    const res = await fetch(`${this.baseUrl}/events/${eventId}/materials`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`list materials failed: ${res.status}`);
    return ((await res.json()) as { materials: MaterialItem[] }).materials;
  }

  async upload(eventId: string, file: File): Promise<void> {
    const contentType = materialContentType(file.name);
    if (!contentType) throw new Error(`対応していない形式です: ${file.name}`);

    const presign = await fetch(`${this.baseUrl}/events/${eventId}/materials/upload-url`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeaders() },
      body: JSON.stringify({ filename: file.name, contentType }),
    });
    if (!presign.ok) {
      const msg = await presign.text().catch(() => presign.statusText);
      throw new Error(`presign failed (${presign.status}): ${msg}`);
    }
    const { uploadUrl } = (await presign.json()) as { uploadUrl: string };

    const put = await fetch(uploadUrl, {
      method: "PUT",
      body: file,
      headers: { "content-type": contentType },
    });
    // 失敗を見ずに終えると、抽出されない資料が登録済みに見えてしまう。
    if (!put.ok) throw new Error(`upload failed: ${put.status}`);
  }

  async remove(eventId: string, assetId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/events/${eventId}/materials/${assetId}`, {
      method: "DELETE",
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`delete material failed: ${res.status}`);
  }
}
