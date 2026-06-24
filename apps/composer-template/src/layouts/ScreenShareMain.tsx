/**
 * ScreenShareMain layout - 画面共有を main、カメラ tile を右側に縦並び。
 * D11: inline style を CSS class に移行。
 */
import { Tile } from "./Tile.js";
import { isScreenShare, tileKey, type VideoTile } from "./types.js";

interface Props {
  tiles: readonly VideoTile[];
}

export function ScreenShareMain(props: Props) {
  const { tiles } = props;
  const screen = tiles.find(isScreenShare);
  const main = screen ?? tiles[0];
  if (!main) return null;
  const subs = tiles.filter((t) => tileKey(t) !== tileKey(main));

  return (
    <div className="screen-share-main-layout">
      <div className={subs.length > 0 ? "screen-share-main" : "screen-share-main--full"}>
        <Tile tile={main} />
      </div>
      {subs.length > 0 && (
        <div className="screen-share-subs">
          {subs.map((t) => (
            <div key={tileKey(t)} className="screen-share-sub-item">
              <Tile tile={t} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
