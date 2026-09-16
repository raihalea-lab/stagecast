/** テスト用フェイク (CLAUDE.md テスト方針: 外部接続なしで完結させる)。 */
import type { MaterialPage } from "@stagecast/shared";
import type { ObjectStore, StoredObject, TextExtractor } from "./types.js";

export class FakeObjectStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly removed: string[] = [];
  /** 指定したキーの get を失敗させる (1 件の失敗が他に波及しないことの検証用)。 */
  failOnGet = new Set<string>();

  putText(key: string, text: string): void {
    this.objects.set(key, new TextEncoder().encode(text));
  }

  async list(prefix: string): Promise<StoredObject[]> {
    return [...this.objects.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((key) => ({ key, size: this.objects.get(key)?.byteLength ?? 0 }));
  }

  async get(key: string): Promise<Uint8Array> {
    if (this.failOnGet.has(key)) throw new Error(`fake get failure: ${key}`);
    const body = this.objects.get(key);
    if (!body) throw new Error(`not found: ${key}`);
    return body;
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, body);
  }

  async remove(key: string): Promise<void> {
    this.removed.push(key);
    this.objects.delete(key);
  }

  readJson<T>(key: string): T | undefined {
    const body = this.objects.get(key);
    return body ? (JSON.parse(new TextDecoder().decode(body)) as T) : undefined;
  }
}

/** 拡張子 `.txt` / `.md` を 1 ページとして返すだけの抽出器。未対応形式は null。 */
export class FakeExtractor implements TextExtractor {
  readonly calls: string[] = [];

  async extract(filename: string, body: Uint8Array): Promise<MaterialPage[] | null> {
    this.calls.push(filename);
    if (!/\.(txt|md)$/.test(filename)) return null;
    const text = new TextDecoder().decode(body);
    // 空行区切りを 1 ページに見立てる (ページ分割の検証用)。
    return text.split("\n\n").map((t) => ({ text: t }));
  }
}
