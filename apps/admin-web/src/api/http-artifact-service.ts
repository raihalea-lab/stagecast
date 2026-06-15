/**
 * 本番用の成果物ダウンロード一覧 (N1, DESIGN.md 6.4)。
 * 制御 API から S3 署名付き GET URL 付きの一覧を取得する。
 */
import type { Artifact, ArtifactService } from "./types.js";

export class HttpArtifactService implements ArtifactService {
  constructor(
    private readonly baseUrl: string,
    private readonly getToken: () => string | undefined,
  ) {}

  async list(eventId: string): Promise<Artifact[]> {
    const token = this.getToken();
    const res = await fetch(`${this.baseUrl}/events/${eventId}/artifacts`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    // S3 未設定 (503) は「成果物なし」として静かに空を返す。
    if (res.status === 503) return [];
    if (!res.ok) throw new Error(`artifacts failed: ${res.status}`);
    const { artifacts } = (await res.json()) as { artifacts: Artifact[] };
    return artifacts;
  }
}
