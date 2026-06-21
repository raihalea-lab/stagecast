/**
 * Tile - 1 video publication を `<video>` に attach するシンプル単位 (R16)。
 *
 * 全 layout で共通の描画ユニット。 size / position は親 layout 側で CSS で制御し、
 * Tile 自身は内部の attach/detach + ラベル表示 + autoplay 補正に専念する。
 */
import { useEffect, useRef } from "react";
import type { VideoTile } from "./types.js";

export function Tile(props: {
  tile: VideoTile;
  /** ラベル表示の有無 (pip の sub では非表示にしたい場合)。 デフォルト true。 */
  showLabel?: boolean;
}) {
  const { tile } = props;
  const showLabel = props.showLabel !== false;
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
      track?.detach();
    };
  }, [tile.publication.track]);

  const label =
    tile.publication.source === "screen_share"
      ? `${tile.participant.name || tile.participant.identity} (画面)`
      : tile.participant.name || tile.participant.identity;

  return (
    <div
      className="tile"
      style={{
        position: "relative",
        background: "#222",
        overflow: "hidden",
        borderRadius: 4,
        width: "100%",
        height: "100%",
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
      {showLabel && (
        <div
          className="tile-label"
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
      )}
    </div>
  );
}
