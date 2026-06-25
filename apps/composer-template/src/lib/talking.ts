/**
 * Talking 判定ロジック (DESIGN.md: audioLevel > 0.2 を 500ms 連続で talking=true)。
 * composer-template の ParticipantTile で talking dot を表示するために使う。
 */

export interface TalkingState {
  isTalking: boolean;
  lastActiveMs: number;
}

const THRESHOLD = 0.2;
const HOLD_MS = 500;

export const INITIAL_STATE: TalkingState = { isTalking: false, lastActiveMs: 0 };

export function updateTalking(prev: TalkingState, audioLevel: number, nowMs: number): TalkingState {
  if (audioLevel > THRESHOLD) {
    return { isTalking: true, lastActiveMs: nowMs };
  }
  if (prev.isTalking && nowMs - prev.lastActiveMs < HOLD_MS) {
    return prev;
  }
  return { isTalking: false, lastActiveMs: prev.lastActiveMs };
}
