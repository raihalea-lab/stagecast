/**
 * 成果物ダウンロードのローカル/テスト実装 (N1)。
 * 注入した一覧をそのまま返す (外部接続なし)。
 */
import type { Artifact, ArtifactService } from "./types.js";

export class InMemoryArtifactService implements ArtifactService {
  constructor(private readonly items: Artifact[] = []) {}
  async list(): Promise<Artifact[]> {
    return this.items;
  }
}
