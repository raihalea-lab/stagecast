/**
 * Pip (Picture-in-Picture) layout - 1 つを full-screen main、 他を右下に小窓 overlay (R16)。
 *
 * focusIdentity を main にし、 残りを右下に縦に並べる (最大 3 つ、 超える分は overflow で隠れる)。
 * 画面共有を main にしたい場合は admin-web から `focusIdentity` を指定する。
 */
import { Tile } from "./Tile.js";
import { tileKey, type VideoTile } from "./types.js";

interface Props {
  tiles: readonly VideoTile[];
  focusIdentity?: string;
}

export function Pip(props: Props) {
  const { tiles, focusIdentity } = props;
  const main =
    (focusIdentity && tiles.find((t) => t.participant.identity === focusIdentity)) || tiles[0];
  if (!main) return null;
  const subs = tiles.filter((t) => tileKey(t) !== tileKey(main)).slice(0, 3);

  return (
    <div
      className="pip-layout"
      style={{ position: "relative", width: "100%", height: "100%", background: "#000" }}
    >
      {/* メイン (フルサイズ)。 */}
      <Tile tile={main} />
      {/* sub (右下にコンパクトに、 小窓スタイル)。 */}
      {subs.length > 0 && (
        <div
          className="pip-subs"
          style={{
            position: "absolute",
            right: 16,
            bottom: 16,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            width: 200,
            zIndex: 10,
          }}
        >
          {subs.map((t) => (
            <div
              key={tileKey(t)}
              style={{
                width: 200,
                height: 112, // 16:9
                boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
                borderRadius: 4,
                overflow: "hidden",
              }}
            >
              <Tile tile={t} showLabel={false} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
