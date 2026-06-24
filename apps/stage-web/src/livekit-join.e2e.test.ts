/**
 * R3 雛形: stage-web → 実 LiveKit の E2E (ADR 0005 R3, ADR 0006「次にやること」)。
 *
 * 本 PR では **雛形のみ** (`describe.skip`)。実際の Playwright 駆動は別 PR
 * (`claude/stage-web-livekit-e2e`) で `e2e/README.md` の手順に沿って実装する。
 * ここに残すのは「何を検証するか」の意図であり、CI では skip されて緑のままになる。
 *
 * 検証したいフロー (R3 完了基準):
 *  1. control-api の `/join` で招待トークンから LiveKit access token を発行する
 *  2. stage-web を開き、発行トークンで実 SFU(LiveKit, EventMediaStack の NLB 経由) に接続
 *  3. ローカルのフェイクメディアで publish し、別ピアで subscribe できる
 *  4. WebRTC が UDP(7882) で確立、塞がれていれば TCP(7881) に fallback する (ADR 0006 D-2)
 */
import { describe, it } from "vitest";

describe.skip("stage-web ⇄ 実 LiveKit E2E (R3, 別 PR で Playwright 実装)", () => {
  it.skip("招待 URL → publish → subscribe が通る", () => {
    // Playwright 実装は e2e/README.md 参照。雛形のため未実装。
  });

  it.skip("UDP 不通時に TCP fallback で接続できる (ADR 0006 D-2)", () => {
    // ネットワーク制限下の ICE fallback 検証。雛形のため未実装。
  });
});
