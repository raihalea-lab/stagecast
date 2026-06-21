/**
 * Spotlight layout - 1 つの tile を大きく中央表示、 他はサムネイルとして下部に並列 (R16)。
 *
 * focusIdentity が指定されていればそれ、 未指定なら publishers 配列の最初を main にする。
 * main にできる tile が無いときは grid にフォールバック (= 全 tile を同等表示)。
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
  if (!main) return null; // tiles 空は Composer 側で待機画面に切替済み。
  const subs = tiles.filter((t) => tileKey(t) !== tileKey(main));

  return (
    <div
      className="spotlight-layout"
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        background: "#000",
        padding: 8,
        gap: 8,
      }}
    >
      {/* メイン (上部 約 80%)。 sub があるなら 80%、 ないなら 100%。 */}
      <div style={{ flex: subs.length > 0 ? "0 0 80%" : "1 1 auto" }}>
        <Tile tile={main} />
      </div>
      {subs.length > 0 && (
        <div
          className="spotlight-subs"
          style={{
            display: "flex",
            gap: 8,
            flex: "1 1 auto",
            overflowX: "auto",
          }}
        >
          {subs.map((t) => (
            <div key={tileKey(t)} style={{ flex: "0 0 auto", width: 200, height: "100%" }}>
              <Tile tile={t} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
