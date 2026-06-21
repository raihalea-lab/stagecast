/**
 * ScreenShareMain layout - 画面共有を main、 カメラ tile を右側に縦並びで補足表示 (R16)。
 *
 * 「画面共有がある時はそれを優先表示」の専用 layout。
 * 画面共有 tile が無ければ spotlight 相当 (= 最初の tile を main にする) にフォールバック。
 * 複数画面共有がある場合は最初の 1 つを main、 残りはカメラと同じ縦列に表示。
 */
import { Tile } from "./Tile.js";
import { isScreenShare, tileKey, type VideoTile } from "./types.js";

interface Props {
  tiles: readonly VideoTile[];
}

export function ScreenShareMain(props: Props) {
  const { tiles } = props;
  const screen = tiles.find(isScreenShare);
  // 画面共有がない場合は spotlight 相当 (最初の tile を main、 残りを右に)。
  const main = screen ?? tiles[0];
  if (!main) return null;
  const subs = tiles.filter((t) => tileKey(t) !== tileKey(main));

  return (
    <div
      className="screen-share-main-layout"
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        background: "#000",
        padding: 8,
        gap: 8,
      }}
    >
      {/* メイン (左側 約 75%)。 sub があるなら 75%、 ないなら 100%。 */}
      <div style={{ flex: subs.length > 0 ? "0 0 75%" : "1 1 auto" }}>
        <Tile tile={main} />
      </div>
      {subs.length > 0 && (
        <div
          className="screen-share-subs"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            flex: "1 1 auto",
            overflowY: "auto",
          }}
        >
          {subs.map((t) => (
            <div key={tileKey(t)} style={{ flex: "0 0 auto", height: 140 }}>
              <Tile tile={t} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
