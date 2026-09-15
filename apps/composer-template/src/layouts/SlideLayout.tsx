/**
 * SlideLayout - 事前アップロードスライド (PDF) を main、カメラ tile を右側に縦並び
 * (F-3, DESIGN.md 5.2)。画面共有メインと同型のレイアウトで、スライド領域に pdf.js 描画を置く。
 */
import { Slide } from "../slides/Slide.js";
import { Tile } from "./Tile.js";
import { tileKey, type VideoTile } from "./types.js";

interface Props {
  tiles: readonly VideoTile[];
  url: string;
  page: number;
}

export function SlideLayout(props: Props) {
  const { tiles, url, page } = props;
  const subs = tiles;

  return (
    <div className="slide-layout">
      <div className={subs.length > 0 ? "slide-main" : "slide-main--full"}>
        <Slide url={url} page={page} />
      </div>
      {subs.length > 0 && (
        <div className="slide-subs">
          {subs.map((t) => (
            <div key={tileKey(t)} className="slide-sub-item">
              <Tile tile={t} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
