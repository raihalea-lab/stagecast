/**
 * イベント単位の共有状態ストア (DESIGN.md 3.2, 5.3)。
 *
 * 本番は ElastiCache for Valkey (Serverless) を用い、ルーム状態・発表者切替状態などの
 * 低レイテンシ共有に使う (ADR D-7)。イベント間の干渉を防ぐため、すべてのキーを
 * イベント ID で名前空間化する (N-5, 7.3)。テストではインメモリ実装に差し替える。
 */
export interface SharedStateStore {
  /** 値を取得する (なければ undefined)。 */
  get(eventId: string, key: string): Promise<string | undefined>;
  /** 値を設定する。 */
  set(eventId: string, key: string, value: string): Promise<void>;
  /** キーを削除する。 */
  del(eventId: string, key: string): Promise<void>;
  /** イベントの名前空間全体を破棄する (イベント終了時)。 */
  clearNamespace(eventId: string): Promise<void>;
}

/** Valkey のキー名 (名前空間込み)。`stagecast:{eventId}:{key}` で衝突を防ぐ。 */
export function namespacedKey(eventId: string, key: string): string {
  return `stagecast:${eventId}:${key}`;
}

/** テスト/ローカル用のインメモリ共有状態ストア。 */
export class InMemorySharedStateStore implements SharedStateStore {
  private readonly store = new Map<string, string>();

  async get(eventId: string, key: string): Promise<string | undefined> {
    return this.store.get(namespacedKey(eventId, key));
  }
  async set(eventId: string, key: string, value: string): Promise<void> {
    this.store.set(namespacedKey(eventId, key), value);
  }
  async del(eventId: string, key: string): Promise<void> {
    this.store.delete(namespacedKey(eventId, key));
  }
  async clearNamespace(eventId: string): Promise<void> {
    const prefix = namespacedKey(eventId, "");
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) this.store.delete(k);
    }
  }

  /** テスト補助: 全キー数。 */
  get size(): number {
    return this.store.size;
  }
}
