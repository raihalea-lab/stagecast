import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";

function captureLine(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  expect(spy).toHaveBeenCalledTimes(1);
  return JSON.parse(spy.mock.calls[0]![0] as string) as Record<string, unknown>;
}

describe("createLogger (N3)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("JSON 1 行で level/time/msg と束縛を出力する", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger({ component: "caption-worker", eventId: "evt-a" });
    log.info("started", { wsPort: 8080 });
    const rec = captureLine(spy);
    expect(rec.level).toBe("info");
    expect(rec.msg).toBe("started");
    expect(rec.component).toBe("caption-worker");
    expect(rec.eventId).toBe("evt-a");
    expect(rec.wsPort).toBe(8080);
    expect(typeof rec.time).toBe("string");
  });

  it("error は console.error に出し Error を message/stack へ正規化する", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = createLogger({ component: "x" });
    log.error("boom", { err: new Error("nope") });
    const rec = captureLine(spy);
    expect(rec.level).toBe("error");
    expect((rec.err as { message: string }).message).toBe("nope");
    expect((rec.err as { stack?: string }).stack).toBeDefined();
  });

  it("level 未満は出力しない (debug < info)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger({}, { level: "info" });
    log.debug("hidden");
    expect(spy).not.toHaveBeenCalled();
  });

  it("child は束縛を継承しつつ追加する", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger({ component: "orchestrator" }).child({ eventId: "evt-b" });
    log.info("reconciled");
    const rec = captureLine(spy);
    expect(rec.component).toBe("orchestrator");
    expect(rec.eventId).toBe("evt-b");
  });
});
