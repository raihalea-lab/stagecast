/**
 * Spotlight layout - 1 tile を大きく中央、他はサムネイルとして下部に並列。
 * D11: inline style を CSS class に移行。
 */
import { Tile } from "./Tile.js";
import { tileKey, type VideoTile } from "./types.js";

interface Props {
  tiles: readonly VideoTile[];
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
      style={{ gridTemplateRows: subs.length > 0 ? "1fr 200px" : "1fr" }}
    >
      <div className="spotlight-main">
        <Tile tile={main} />
      </div>
      {subs.length > 0 && (
        <div className="spotlight-subs">
          {subs.map((t) => (
            <div key={tileKey(t)} className="spotlight-sub-item">
              <Tile tile={t} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
