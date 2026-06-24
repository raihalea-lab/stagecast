import { describe, expect, it } from "vitest";
import { createEgressService, joinRtmpUrl, type EgressStarter, type StreamKeyResolver } from "./egress.js";
import { createEventService } from "./events.js";
import { MemoryEventRepository } from "../repo/memory.js";
import { ValidationError } from "./events.js";
import { ServiceUnavailableError } from "./join.js";

function buildEvents() {
  const repo = new MemoryEventRepository();
  let counter = 0;
  return createEventService({
    repo,
    newId: () => `evt-${++counter}`,
    now: () => 1_000_000,
  });
}

function fakeStarter(): EgressStarter & {
  calls: { livekitUrl: string; roomName: string; streamUrl: string }[];
} {
  const calls: { livekitUrl: string; roomName: string; streamUrl: string }[] = [];
  return {
    calls,
    async startRtmpEgress(input) {
      calls.push(input);
      return { egressId: `egress-${calls.length}` };
    },
  };
}

function fakeResolver(map: Record<string, string>): StreamKeyResolver {
  return {
    async resolve(ref) {
      const v = map[ref];
      if (!v) throw new Error(`not found: ${ref}`);
      return v;
    },
  };
}

describe("EgressService.start (R12)", () => {
  it("live + media + youtube が揃っているときに Egress を起動する", async () => {
    const events = buildEvents();
    const created = await events.create({
      title: "test",
      startsAt: "2026-06-19T00:00:00.000Z",
      caption: { languages: ["ja"], youtubeLanguage: "ja", engine: "transcribe", customApiEnabled: false },
      youtube: { rtmpUrl: "rtmp://a.rtmp.youtube.com/live2", streamKeyRef: "key1" },
    });
    await events.setStatus(created.id, "live");
    // reconcile が media を書き戻したとシミュレート
    await events.update(created.id, { media: { livekitUrl: "wss://x", readyAt: 1 } } as never);

    const starter = fakeStarter();
    const egress = createEgressService({
      events,
      starter,
      streamKeyResolver: fakeResolver({ key1: "secret-stream-key" }),
    });

    const result = await egress.start(created.id);

    expect(result.egressId).toBe("egress-1");
    expect(starter.calls[0]?.streamUrl).toBe(
      "rtmp://a.rtmp.youtube.com/live2/secret-stream-key",
    );
    expect(starter.calls[0]?.roomName).toBe(created.id);
    expect(starter.calls[0]?.livekitUrl).toBe("wss://x");
  });

  it("status が live でなければ ValidationError", async () => {
    const events = buildEvents();
    const created = await events.create({
      title: "draft",
      startsAt: "2026-06-19T00:00:00.000Z",
      caption: { languages: ["ja"], youtubeLanguage: "ja", engine: "transcribe", customApiEnabled: false },
      youtube: { rtmpUrl: "rtmp://x", streamKeyRef: "k" },
    });
    const egress = createEgressService({
      events,
      starter: fakeStarter(),
      streamKeyResolver: fakeResolver({ k: "s" }),
    });
    await expect(egress.start(created.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it("media.livekitUrl 未確定なら 503 (ServiceUnavailable)", async () => {
    const events = buildEvents();
    const created = await events.create({
      title: "live",
      startsAt: "2026-06-19T00:00:00.000Z",
      caption: { languages: ["ja"], youtubeLanguage: "ja", engine: "transcribe", customApiEnabled: false },
      youtube: { rtmpUrl: "rtmp://x", streamKeyRef: "k" },
    });
    await events.setStatus(created.id, "live");
    const egress = createEgressService({
      events,
      starter: fakeStarter(),
      streamKeyResolver: fakeResolver({ k: "s" }),
    });
    await expect(egress.start(created.id)).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it("youtube.rtmpUrl が無ければ ValidationError", async () => {
    const events = buildEvents();
    const created = await events.create({
      title: "no-youtube",
      startsAt: "2026-06-19T00:00:00.000Z",
      caption: { languages: ["ja"], youtubeLanguage: "ja", engine: "transcribe", customApiEnabled: false },
    });
    await events.setStatus(created.id, "live");
    await events.update(created.id, { media: { livekitUrl: "wss://x", readyAt: 1 } } as never);
    const egress = createEgressService({
      events,
      starter: fakeStarter(),
      streamKeyResolver: fakeResolver({}),
    });
    await expect(egress.start(created.id)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("joinRtmpUrl", () => {
  it("末尾スラッシュなしの URL に streamKey を付ける", () => {
    expect(joinRtmpUrl("rtmp://x/live2", "k1")).toBe("rtmp://x/live2/k1");
  });

  it("末尾スラッシュ付きの URL でも二重 / にならない", () => {
    expect(joinRtmpUrl("rtmp://x/live2/", "k1")).toBe("rtmp://x/live2/k1");
  });
});
