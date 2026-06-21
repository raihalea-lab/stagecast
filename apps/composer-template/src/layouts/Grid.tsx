/**
 * Grid layout - 全 publishing participant を等比グリッドで並べる (R15)。
 *
 * Egress の RoomComposite が描画する H.264 1280x720 に対し、 CSS grid で
 * 自動的に行列数を計算する (1人=1x1, 2人=1x2, 3-4人=2x2, 5-6人=2x3, 7-9人=3x3)。
 * 各 tile は LiveKit の videoTrack を `<video>` 要素に attach するだけ。
 */
import { useEffect, useRef } from "react";
import type { Participant, RemoteTrackPublication } from "livekit-client";

interface Props {
  publishers: readonly Participant[];
}

export function Grid(props: Props) {
  const { publishers } = props;
  const cols = computeCols(publishers.length);
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
      {publishers.map((p) => (
        <Tile key={p.sid} participant={p} />
      ))}
    </div>
  );
}

/**
 * Grid layout のカラム数を participant 数から計算する。 1人=1, 2人=2, 3-4人=2 (2x2),
 * 5-6人=3 (2x3), 7+人=3 (3x3, 9 人まで自然に並ぶ)。 export はテスト用。
 */
export function computeCols(count: number): number {
  if (count <= 1) return 1;
  if (count <= 2) return 2;
  if (count <= 4) return 2;
  if (count <= 6) return 3;
  return 3; // 7-9 人を 3x3 まで想定。 10 人以上は overflow するが、 R15 のスコープ外。
}

function Tile(props: { participant: Participant }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const videoPubs = Array.from(props.participant.videoTrackPublications.values());
    const audioPubs = Array.from(props.participant.audioTrackPublications.values());
    const videoPub = videoPubs.find((t) => !t.isMuted) as RemoteTrackPublication | undefined;
    const audioPub = audioPubs.find((t) => !t.isMuted) as RemoteTrackPublication | undefined;
    if (videoPub?.track && videoRef.current) {
      videoPub.track.attach(videoRef.current);
    }
    if (audioPub?.track && audioRef.current) {
      audioPub.track.attach(audioRef.current);
    }
    return () => {
      // detach は track 側で「全 element から detach」を行うので element を渡さない。
      videoPub?.track?.detach();
      audioPub?.track?.detach();
    };
    // participant は安定参照 (Composer 側で setPublishers の再計算で同 sid なら同一参照を維持しないが、
    // useEffect は participant 入れ替わりで再 attach するので不整合は起きない)。
  }, [props.participant]);

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
      <audio ref={audioRef} autoPlay />
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
        {props.participant.name || props.participant.identity}
      </div>
    </div>
  );
}
