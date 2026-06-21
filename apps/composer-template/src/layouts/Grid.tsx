/**
 * Grid layout - 全 publishing video を等比グリッドで並べる (R15)。
 *
 * Egress の RoomComposite が描画する H.264 1280x720 に対し、 CSS grid で
 * 自動的に行列数を計算する (1人=1x1, 2人=1x2, 3-4人=2x2, 5-6人=2x3, 7-9人=3x3)。
 *
 * R15-followup-3: 1 video publication = 1 tile (StreamYard 風)。
 * 同じ participant がカメラ + 画面共有を同時に publish した場合は 2 tile に並ぶ。
 * 以前の participant 単位だと最初の publication しか拾えず画面共有が無視されていた。
 */
import { useEffect, useRef } from "react";
import type { Participant, RemoteTrackPublication } from "livekit-client";

/**
 * 1 つの video tile を表す。 participant の表示名と publication を持つ。
 * 同じ participant の複数 publication (camera + screen-share) はそれぞれ別 tile になる。
 */
export interface VideoTile {
  participant: Participant;
  publication: RemoteTrackPublication;
}

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
      }}
    >
      {tiles.map((t) => (
        // R15-followup-3: key は participant sid + publication sid。 1 participant が複数
        // publication を持つ場合に同じ key にならないようにする (React の重複 key warning 回避)。
        <Tile key={`${t.participant.sid}:${t.publication.trackSid}`} tile={t} />
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

function Tile(props: { tile: VideoTile }) {
  const { tile } = props;
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const track = tile.publication.track;
    if (track && videoRef.current) {
      track.attach(videoRef.current);
      // R15-followup-2: Chrome autoplay policy で attach 直後に play() を明示呼出する
      // ケースがある (特に mute → unmute 後の再 attach)。 失敗は無視。
      videoRef.current.play().catch(() => {});
    }
    return () => {
      // detach は track 側で「全 element から detach」を行うので element を渡さない。
      track?.detach();
    };
    // R15-followup-2: track 参照を dependency に含めて再 subscribe に追従。
  }, [tile.publication.track]);

  // 画面共有か camera かをラベルに付ける (R15-followup-3)。
  const label =
    tile.publication.source === "screen_share"
      ? `${tile.participant.name || tile.participant.identity} (画面)`
      : tile.participant.name || tile.participant.identity;

  return (
    <div
      className="grid-tile"
      style={{ position: "relative", background: "#222", overflow: "hidden", borderRadius: 4 }}
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
      <div
        className="grid-tile-label"
        style={{
          position: "absolute",
          left: 8,
          bottom: 8,
          padding: "4px 8px",
          background: "rgba(0,0,0,0.6)",
          color: "#fff",
          fontFamily: "sans-serif",
          fontSize: 14,
          borderRadius: 4,
        }}
      >
        {label}
      </div>
    </div>
  );
}
