/**
 * Grid layout - 全 publishing video を等比グリッドで並べる (R15)。
 *
 * Egress の RoomComposite が描画する H.264 1280x720 に対し、 CSS grid で
 * 自動的に行列数を計算する (1人=1x1, 2人=1x2, 3-4人=2x2, 5-6人=2x3, 7-9人=3x3)。
 * 同じ participant がカメラ + 画面共有を同時に publish した場合は 2 tile に並ぶ
 * (R15-followup-3, StreamYard 風)。
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
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gap: 8,
        width: "100%",
        height: "100%",
        background: "#000",
        padding: 8,
      }}
    >
      {tiles.map((t) => (
        <Tile key={tileKey(t)} tile={t} />
      ))}
    </div>
  );
}

/**
 * Grid layout のカラム数を tile 数から計算する。 1=1, 2=2, 3-4=2 (2x2),
 * 5-6=3 (2x3), 7+=3 (3x3, 9 まで自然に並ぶ)。 export はテスト用。
 */
export function computeCols(count: number): number {
  if (count <= 1) return 1;
  if (count <= 2) return 2;
  if (count <= 4) return 2;
  if (count <= 6) return 3;
  return 3; // 7-9 を 3x3 まで想定。 10 以上は overflow するが、 R15 のスコープ外。
}
