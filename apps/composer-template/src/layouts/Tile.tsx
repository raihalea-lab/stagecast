/**
 * Tile - 1 video publication を attach するユニット。
 *
 * D11 刷新: lower third をグラデ overlay に変更、talking dot 追加、
 * screen_share にはラベル表示。inline style を CSS class に移行。
 */
import { useEffect, useRef } from "react";
import type { VideoTile } from "./types.js";

export function Tile(props: {
  tile: VideoTile;
  showLabel?: boolean;
  isTalking?: boolean;
}) {
  const { tile } = props;
  const showLabel = props.showLabel !== false;
  const videoRef = useRef<HTMLVideoElement>(null);
  const isScreen = tile.publication.source === "screen_share";

  useEffect(() => {
    const track = tile.publication.track;
    if (track && videoRef.current) {
      track.attach(videoRef.current);
      videoRef.current.play().catch(() => {});
    }
    return () => {
      track?.detach();
    };
  }, [tile.publication.track]);

  const label = isScreen
    ? `${tile.participant.name || tile.participant.identity} (画面)`
    : tile.participant.name || tile.participant.identity;

  return (
    <div className={`tile${isScreen ? " tile--screen" : ""}`}>
      <video ref={videoRef} autoPlay muted playsInline className="tile-video" />
      {showLabel && (
        <div className="tile-lower-third">
          {props.isTalking && <span className="tile-talking-dot" />}
          <span className="tile-label">{label}</span>
        </div>
      )}
      {isScreen && <span className="tile-screen-badge">SCREEN SHARE</span>}
    </div>
  );
}
