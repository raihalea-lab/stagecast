/**
 * 主要 component の a11y smoke test (axe-core)。
 * 各 component を jsdom で render し、 violations が 0 件であることを確認する。
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import axe from "axe-core";
import { Button } from "../primitives/button.js";
import { Input } from "../primitives/input.js";
import { Label } from "../primitives/label.js";
import { Card, CardContent, CardHeader, CardTitle } from "../primitives/card.js";
import { TallyIndicator } from "./tally-indicator.js";
import { MonoNumber } from "./mono-number.js";
import { StatusPill } from "./status-pill.js";
import { EmptyState } from "./empty-state.js";
import { DeviceMeter } from "./device-meter.js";
import { LiveTensionBar } from "./live-tension-bar.js";
import { ReconnectingBanner } from "./reconnecting-banner.js";
import { LiveStats } from "./live-stats.js";
import { EventListItem } from "./event-list-item.js";

async function expectNoViolations(element: HTMLElement) {
  const results = await axe.run(element, {
    rules: {
      // jsdom は color-contrast 系を正確に評価できないので無効化
      "color-contrast": { enabled: false },
    },
  });
  expect(results.violations).toEqual([]);
}

describe("axe a11y smoke", () => {
  it("Button", async () => {
    const { container } = render(<Button>配信開始</Button>);
    await expectNoViolations(container);
  });

  it("Input + Label", async () => {
    const { container } = render(
      <>
        <Label htmlFor="t">タイトル</Label>
        <Input id="t" placeholder="入力" />
      </>,
    );
    await expectNoViolations(container);
  });

  it("Card", async () => {
    const { container } = render(
      <Card>
        <CardHeader>
          <CardTitle>YouTube</CardTitle>
        </CardHeader>
        <CardContent>本文</CardContent>
      </Card>,
    );
    await expectNoViolations(container);
  });

  it("TallyIndicator (on-air)", async () => {
    const { container } = render(<TallyIndicator state="on-air" />);
    await expectNoViolations(container);
  });

  it("MonoNumber", async () => {
    const { container } = render(<MonoNumber value={1280} unit="kbps" />);
    await expectNoViolations(container);
  });

  it("StatusPill", async () => {
    const { container } = render(<StatusPill variant="live" />);
    await expectNoViolations(container);
  });

  it("EmptyState", async () => {
    const { container } = render(<EmptyState title="空です" description="まだ何もありません" />);
    await expectNoViolations(container);
  });

  it("DeviceMeter", async () => {
    const { container } = render(<DeviceMeter level={0.5} showDb />);
    await expectNoViolations(container);
  });

  it("LiveTensionBar", async () => {
    const { container } = render(<LiveTensionBar state="live" />);
    await expectNoViolations(container);
  });

  it("ReconnectingBanner", async () => {
    const { container } = render(<ReconnectingBanner kind="reconnecting" />);
    await expectNoViolations(container);
  });

  it("LiveStats", async () => {
    const { container } = render(
      <LiveStats
        stats={{
          bitrateKbps: 4280,
          droppedFrames: 0,
          captionLagMs: 2840,
          participantCount: 9,
          elapsedSec: 1842,
        }}
      />,
    );
    await expectNoViolations(container);
  });

  it("EventListItem", async () => {
    const { container } = render(
      <EventListItem
        title="Tech Conf 2026"
        startsAt="2026-07-01T09:00:00+09:00"
        status="live"
        active
      />,
    );
    await expectNoViolations(container);
  });
});
