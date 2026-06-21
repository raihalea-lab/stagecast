/**
 * 各 layout / Tile が受け取る共通型 (R16)。
 *
 * VideoTile は composer-template の中で 1 video publication = 1 unit。 同じ participant が
 * カメラ + 画面共有を publish した場合は別 tile になる (R15-followup-3)。
 */
import type { Participant, RemoteTrackPublication } from "livekit-client";

export interface VideoTile {
  participant: Participant;
  publication: RemoteTrackPublication;
}

/** Tile の安定 key (React の key prop に使う)。 1 participant が複数 publication を持っても重複しない。 */
export function tileKey(t: VideoTile): string {
  return `${t.participant.sid}:${t.publication.trackSid}`;
}

/** screen-share publication かどうかの判定。 */
export function isScreenShare(t: VideoTile): boolean {
  return t.publication.source === "screen_share";
}
