/**
 * 抽出サービスの外部依存インターフェース (ADR 0021 D-2)。
 *
 * CLAUDE.md のテスト方針に従い、S3 とテキスト抽出をインターフェース越しにして
 * 外部接続なしでテストを完結させる。
 */
import type { MaterialPage } from "@stagecast/shared";

/** S3 に置かれた 1 オブジェクトの要約。 */
export interface StoredObject {
  key: string;
  size: number;
}

/** 資料の読み書き。実体は S3。 */
export interface ObjectStore {
  /** prefix 配下のオブジェクトを列挙する。 */
  list(prefix: string): Promise<StoredObject[]>;
  /** オブジェクトの中身を取得する。 */
  get(key: string): Promise<Uint8Array>;
  /** オブジェクトを書き込む。 */
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** オブジェクトを削除する。 */
  remove(key: string): Promise<void>;
}

/**
 * 1 ファイルからページ別テキストを取り出す。対応しない形式は null を返す
 * (エラーにしない: 対応外の資料が 1 つあっても他の資料の抽出は続ける)。
 */
export interface TextExtractor {
  extract(filename: string, body: Uint8Array): Promise<MaterialPage[] | null>;
}
