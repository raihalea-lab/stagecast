/**
 * 事前作成済みスタックのテンプレート鮮度 (ADR 0016 D-4 の制約)。
 *
 * provisioner は `createStack` しか呼ばない = **更新経路が無い**。ADR 0016 D-4 で
 * `scheduled` の時点でスタックを先に作るので、テンプレートを変えても既存の `scheduled`
 * イベントには反映されず、開催時刻に古い構成で立ち上がる。2026-09-19 の ADR 0028
 * (メディア層のホスト名と Caddy 起動コマンドの変更) で実際に踏みかけた。
 *
 * そこで作成時に「テンプレートの版」をタグで残し、ズレていたら作り直す。
 *
 * **版の計算は RenderTemplateFunction 側で行う** (`render-template-handler.ts`)。
 * 版を決めるのはレンダリング処理と env で、それはその Lambda を入れ替えないと変わらない。
 * reconcile 側でキャッシュすると別関数の寿命に紐づいた古い版を持ち続け、新旧コンテナが
 * 別の版を主張してスタックの破棄と再作成が毎 tick フラップする。
 *
 * **限界**: 版は代表 1 パターン (`transcribe` / `customCaptionApi: false`) の
 * レンダリング結果から取る。`bedrock` 分岐や `customCaptionApi: true` にしか効かない
 * テンプレート変更はハッシュが動かず、該当イベントの事前作成スタックは古いまま残る
 * (逆に無関係な分岐の変更で全イベントが作り直される)。
 * 全パターンをレンダリングするコストに見合わないので、この粗さを受け入れている。
 */
import { createHash } from "node:crypto";

/** スタックに付ける版タグのキー。 */
export const TEMPLATE_VERSION_TAG = "stagecast:template-version";

/**
 * 版の判定に使う代表イベント ID。
 *
 * テンプレートは eventId を埋め込むので、実イベントごとにレンダリングするとハッシュが
 * 全部違ってしまう。**版として見たいのは「レンダリング処理と env」**なので、固定の ID で
 * 1 回だけレンダリングしてその差分を見る。
 */
export const CANONICAL_EVENT_ID = "template-version-probe";

export function hashTemplate(templateBody: string): string {
  return createHash("sha256").update(templateBody).digest("hex").slice(0, 16);
}
