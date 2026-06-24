/**
 * Grid layout - 全 publishing video を等比グリッドで並べる。
 * D11: inline style を CSS class に移行、背景色を #17171C に統一。
 */
import { Tile } from "./Tile.js";
import { tileKey, type VideoTile } from "./types.js";

interface Props {
  tiles: readonly VideoTile[];
}

export function Grid(props: Props) {
  const { tiles } = props;
  const cols = computeCols(tiles.length);
  return (
    <div
      className="grid-layout"
      style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
    >
      {tiles.map((t) => (
        <Tile key={tileKey(t)} tile={t} />
      ))}
    </div>
  );
}

export function computeCols(count: number): number {
  if (count <= 1) return 1;
  if (count <= 2) return 2;
  if (count <= 4) return 2;
  if (count <= 6) return 3;
  return 3;
}
