import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LiveStats } from "./live-stats.js";

describe("LiveStats", () => {
  // STAGE_UX_PLAN U-5: 経路の無い指標を「-」で並べると「壊れている」と読まれる。
  it("値の無い指標は表示しない", () => {
    render(<LiveStats stats={{ participantCount: 3, elapsedSec: 42 }} />);
    expect(screen.getByText("参加者")).toBeTruthy();
    expect(screen.getByText("経過")).toBeTruthy();
    expect(screen.queryByText("字幕遅延")).toBeNull();
    expect(screen.queryByText("ビットレート")).toBeNull();
    expect(screen.queryByText("ドロップ")).toBeNull();
  });
});
