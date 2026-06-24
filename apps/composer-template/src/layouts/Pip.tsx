/**
 * Pip (Picture-in-Picture) layout - 1 tile を full-screen、他を右下に小窓 overlay。
 * D11: inline style を CSS class に移行、shadow を hairline + 軽 shadow に。
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
    <div className="pip-layout">
      <Tile tile={main} />
      {subs.length > 0 && (
        <div className="pip-subs">
          {subs.map((t) => (
            <div key={tileKey(t)} className="pip-sub-item">
              <Tile tile={t} showLabel={false} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
