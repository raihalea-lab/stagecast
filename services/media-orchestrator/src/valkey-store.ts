/**
 * ElastiCache for Valkey 実装の SharedStateStore (DESIGN.md 3.2, 7.2, ADR D-7)。
 *
 * Valkey/Redis 互換クライアントを注入する。クライアント実装 (redis / ioredis 等) に依存
 * しないよう最小の操作だけを ValkeyClient として抽象化し、テストでは fake を注入する。
 * 名前空間化はキー規約 (stagecast:{eventId}:{key}) で行い、イベント間の干渉を防ぐ (N-5)。
 */
import { namespacedKey, type SharedStateStore } from "./shared-state.js";

export interface ValkeyClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  /** 接頭辞に一致するキー一覧を返す (名前空間破棄に使用)。 */
  keysByPrefix(prefix: string): Promise<string[]>;
}

export class ValkeySharedStateStore implements SharedStateStore {
  constructor(private readonly client: ValkeyClient) {}

  async get(eventId: string, key: string): Promise<string | undefined> {
    const value = await this.client.get(namespacedKey(eventId, key));
    return value ?? undefined;
  }
  async set(eventId: string, key: string, value: string): Promise<void> {
    await this.client.set(namespacedKey(eventId, key), value);
  }
  async del(eventId: string, key: string): Promise<void> {
    await this.client.del(namespacedKey(eventId, key));
  }
  async clearNamespace(eventId: string): Promise<void> {
    const prefix = namespacedKey(eventId, "");
    const keys = await this.client.keysByPrefix(prefix);
    await Promise.all(keys.map((k) => this.client.del(k)));
  }
}
