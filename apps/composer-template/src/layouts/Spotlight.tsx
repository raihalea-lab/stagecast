/**
 * Spotlight layout - 1 つの tile を大きく中央表示、 他はサムネイルとして下部に並列 (R16)。
 *
 * focusIdentity が指定されていればそれ、 未指定なら publishers 配列の最初を main にする。
 * main にできる tile が無いときは描画なし (Composer 側で待機画面に切替済み)。
 *
 * R16-followup-1: 高さ計算を flex column → grid に変更。 flex column での `flex: 0 0 80%`
 * は Chrome の一部バージョンで意図通りに展開されず main が高さ 0 になる問題があった。
 * grid `gridTemplateRows: "1fr 200px"` で main 行を残り全部、 sub 行を 200px に明示する。
 * 各子要素に `minHeight: 0` を付けて grid 内で内容物が圧縮されるようにする。
 */
import { Tile } from "./Tile.js";
import { tileKey, type VideoTile } from "./types.js";

interface Props {
  tiles: readonly VideoTile[];
  /** メイン表示する participant identity (省略時は tiles[0])。 */
  focusIdentity?: string;
}

export function Spotlight(props: Props) {
  const { tiles, focusIdentity } = props;
  const main =
    (focusIdentity && tiles.find((t) => t.participant.identity === focusIdentity)) || tiles[0];
  if (!main) return null;
  const subs = tiles.filter((t) => tileKey(t) !== tileKey(main));

  return (
    <div
      className="spotlight-layout"
      style={{
        display: "grid",
        // sub があるなら 2 行 (main + サムネイル列)、 ないなら 1 行 (main full)。
        gridTemplateRows: subs.length > 0 ? "1fr 200px" : "1fr",
        width: "100%",
        height: "100%",
        background: "#000",
        padding: 8,
        gap: 8,
      }}
    >
      {/* main row: minHeight 0 で内容物の高さ要求に押されないようにする。 */}
      <div style={{ minHeight: 0 }}>
        <Tile tile={main} />
      </div>
      {subs.length > 0 && (
        <div
          className="spotlight-subs"
          style={{
            display: "flex",
            gap: 8,
            overflowX: "auto",
            minHeight: 0,
          }}
        >
          {subs.map((t) => (
            <div
              key={tileKey(t)}
              style={{ flex: "0 0 auto", width: 200, height: "100%" }}
            >
              <Tile tile={t} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
