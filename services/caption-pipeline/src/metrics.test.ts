import { describe, expect, it } from "vitest";
import type { CaptionEvent } from "@stagecast/shared";
import { CaptionMetricsCollector, ConsoleEmfMetricsSink, InMemoryMetricsSink } from "./metrics.js";

function caption(over: Partial<CaptionEvent> = {}): CaptionEvent {
  return {
    startMs: 1000,
    endMs: 2000,
    language: "ja",
    text: "テスト",
    status: "final",
    ...over,
  };
}

describe("CaptionMetricsCollector (T9)", () => {
  it("字幕 1 件で CaptionLatencyMs + CaptionsPublished を発行", () => {
    const sink = new InMemoryMetricsSink();
    const collector = new CaptionMetricsCollector({
      eventId: "evt-1",
      sink,
      now: () => 1500, // 500ms 遅延
    });
    collector.observeCaption(caption());
    expect(sink.records).toHaveLength(1);
    const rec = sink.records[0]!;
    expect(rec.namespace).toBe("Stagecast/CaptionPipeline");
    expect(rec.dimensions).toEqual({ EventId: "evt-1", Status: "final", Language: "ja" });
    expect(rec.metrics.find((m) => m.name === "CaptionLatencyMs")?.value).toBe(500);
    expect(rec.metrics.find((m) => m.name === "CaptionsPublished")?.value).toBe(1);
  });

  it("interim と final で Status dimension が分かれる", () => {
    const sink = new InMemoryMetricsSink();
    const collector = new CaptionMetricsCollector({ eventId: "e", sink, now: () => 1000 });
    collector.observeCaption(caption({ status: "interim" }));
    collector.observeCaption(caption({ status: "final" }));
    expect(sink.records.map((r) => r.dimensions.Status)).toEqual(["interim", "final"]);
  });

  it("observeSinkError は SinkDeliveryErrors を発行", () => {
    const sink = new InMemoryMetricsSink();
    const collector = new CaptionMetricsCollector({ eventId: "e", sink });
    collector.observeSinkError("youtube");
    expect(sink.records[0]?.metrics[0]?.name).toBe("SinkDeliveryErrors");
    expect(sink.records[0]?.dimensions.Sink).toBe("youtube");
  });

  it("ConsoleEmfMetricsSink は EMF JSON を 1 行で書き出す", () => {
    const lines: string[] = [];
    const sink = new ConsoleEmfMetricsSink((l) => lines.push(l));
    sink.emit({
      namespace: "Test",
      metrics: [{ name: "Foo", unit: "Count", value: 1 }],
      dimensions: { A: "x" },
      timestampMs: 1700000000000,
    });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed._aws.CloudWatchMetrics[0]).toMatchObject({
      Namespace: "Test",
      Dimensions: [["A"]],
      Metrics: [{ Name: "Foo", Unit: "Count" }],
    });
    expect(parsed.A).toBe("x");
    expect(parsed.Foo).toBe(1);
  });
});
