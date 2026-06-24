/**
 * Valkey/Redis Streams クライアントの本番実装 (T3, ADR 0002)。
 *
 * ioredis を使って `CaptionStreamClient` (xadd / read) を実装する。
 * 設計方針:
 *  - `XADD ... MAXLEN ~ N` で短期バッファに徹する (ADR 0002 保持/上限)。
 *  - `XREAD BLOCK` で long-poll 購読。abort 検知のため BLOCK タイムアウトを 1s 程度に。
 *  - エラーは再接続 (ioredis 任せ) で隠す。アプリ層には例外を上げない (フェイルソフト)。
 *
 * 接続情報は `VALKEY_URL` (=`redis://host:6379` 等) で受け取る。TLS が要れば `rediss://`。
 */
import type { CaptionStreamClient } from "./valkey-bus.js";

/** ioredis 最小サブセット (テスト容易性のために interface 化)。 */
export interface RedisClientLike {
  /** XADD stream MAXLEN ~ N * payload */
  xadd(
    stream: string,
    maxlenOp: "MAXLEN",
    approx: "~",
    n: number,
    star: "*",
    field: string,
    value: string,
  ): Promise<string | null>;
  /** XREAD BLOCK ms COUNT n STREAMS stream lastId — 戻り値は ioredis 標準形式。 */
  xread(
    ...args: (string | number)[]
  ): Promise<[stream: string, entries: [id: string, fields: string[]][]][] | null>;
  quit(): Promise<unknown>;
}

export interface ValkeyStreamClientOptions {
  client: RedisClientLike;
  /** XADD で適用する近似トリム上限 (既定 5000 = 数分ぶんの字幕)。 */
  maxLen?: number;
  /** XREAD BLOCK タイムアウト (ms, 既定 1000)。abort 反応性とバランス。 */
  blockMs?: number;
  /** 1 回の XREAD で取得する上限件数 (既定 100)。 */
  count?: number;
  /** ペイロードを格納するフィールド名 (既定 "payload")。 */
  field?: string;
}

/**
 * `CaptionStreamClient` の Valkey 実装。ioredis 互換のクライアントを注入して使う。
 */
export class ValkeyStreamClient implements CaptionStreamClient {
  private readonly maxLen: number;
  private readonly blockMs: number;
  private readonly count: number;
  private readonly field: string;
  private readonly client: RedisClientLike;

  constructor(options: ValkeyStreamClientOptions) {
    this.client = options.client;
    this.maxLen = options.maxLen ?? 5000;
    this.blockMs = options.blockMs ?? 1000;
    this.count = options.count ?? 100;
    this.field = options.field ?? "payload";
  }

  async xadd(stream: string, payload: string): Promise<string> {
    const id = await this.client.xadd(stream, "MAXLEN", "~", this.maxLen, "*", this.field, payload);
    return id ?? "0-0";
  }

  async *read(
    stream: string,
    lastId: string,
    signal: { aborted: boolean },
  ): AsyncIterable<{ id: string; payload: string }> {
    let cursor = lastId;
    while (!signal.aborted) {
      let res: [string, [string, string[]][]][] | null = null;
      try {
        res = await this.client.xread(
          "COUNT",
          this.count,
          "BLOCK",
          this.blockMs,
          "STREAMS",
          stream,
          cursor,
        );
      } catch {
        // 接続断などは少し待ってリトライ (ioredis が再接続する)。
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      if (!res) continue; // BLOCK タイムアウト → ループ継続 (abort チェック)
      for (const [, entries] of res) {
        for (const [id, fields] of entries) {
          const payload = extractPayload(fields, this.field);
          if (payload !== undefined) yield { id, payload };
          cursor = id;
        }
      }
    }
  }
}

/** XREAD の fields 配列 (["field","val","field","val",...]) から目的フィールドを取り出す。 */
function extractPayload(fields: string[], target: string): string | undefined {
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] === target) return fields[i + 1];
  }
  return undefined;
}

/**
 * 環境変数から ioredis ベースのクライアントを構築する。
 * ioredis 本体は遅延 import (テストでは使われない)。
 */
export async function valkeyStreamClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ValkeyStreamClient | undefined> {
  const url = env.VALKEY_URL ?? env.VALKEY_ENDPOINT;
  if (!url) return undefined;
  // ioredis: 接続文字列 or ホスト/ポート単体。EventMediaStack の VALKEY_ENDPOINT は
  // ホスト名だけ来る (CFN 出力)。`redis://` がついていなければ補う。
  const conn = /^rediss?:\/\//.test(url) ? url : `redis://${url}:6379`;
  const pkgName = "ioredis";
  const mod = (await import(/* @vite-ignore */ pkgName)) as unknown as {
    default: new (url: string) => RedisClientLike;
  };
  const Ctor = mod.default;
  return new ValkeyStreamClient({ client: new Ctor(conn) });
}
