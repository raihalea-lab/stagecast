/**
 * 事前作成済みスタックのテンプレート鮮度 (D18)。
 *
 * `CloudFormationMediaStackProvisioner` は `createStack` しか呼ばない = **更新経路が無い**。
 * ADR 0016 D-4 で `scheduled` の時点でスタックを先に作るので、テンプレートを変えても
 * 既存の `scheduled` イベントには反映されず、開催時刻に古い構成で立ち上がる。
 * 2026-09-19 の ADR 0028 (メディア層のホスト名と Caddy 起動コマンドの変更) で実際に
 * 踏みかけた (そのとき `scheduled` が 0 件だったため実害は出なかった)。
 *
 * そこで作成時に「テンプレートの版」をタグで残し、ズレていたら作り直す。
 */
import { createHash } from "node:crypto";

/** スタックに付ける版タグのキー。 */
export const TEMPLATE_VERSION_TAG = "stagecast:template-version";

/**
 * 版の判定に使う代表イベント ID。
 *
 * テンプレートは eventId を埋め込むので、実イベントごとにレンダリングすると
 * ハッシュが全部違ってしまう。**版として見たいのは「レンダリング処理と env」**なので、
 * 固定の ID で 1 回だけレンダリングしてその差分を見る。
 */
const CANONICAL_EVENT_ID = "template-version-probe";

export function hashTemplate(templateBody: string): string {
  return createHash("sha256").update(templateBody).digest("hex").slice(0, 16);
}

/**
 * 現在のテンプレート版を返す。**コールドスタートごとに 1 回だけ**レンダリングする。
 *
 * レンダリングは Lambda 呼び出し + CDK synth で数秒かかるので、毎 tick は回せない。
 * レンダリング処理も env も Lambda を入れ替えないと変わらない = コンテナの寿命と
 * 一致するので、キャッシュしてよい。
 */
export function createTemplateVersionResolver(
  render: (spec: {
    eventId: string;
    captionEngine: "transcribe";
    customCaptionApi: false;
  }) => Promise<string>,
) {
  let cached: string | undefined;
  return async (): Promise<string | undefined> => {
    if (cached) return cached;
    try {
      cached = hashTemplate(
        await render({
          eventId: CANONICAL_EVENT_ID,
          captionEngine: "transcribe",
          customCaptionApi: false,
        }),
      );
      return cached;
    } catch {
      // 版が取れないときは**比較しない** (undefined)。ここで失敗して作り直しを止めるより、
      // 古いままにしておくほうが安全side (作り直しは次の tick で再試行される)。
      return undefined;
    }
  };
}
