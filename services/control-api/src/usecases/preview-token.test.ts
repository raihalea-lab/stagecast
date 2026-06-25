import { describe, expect, it } from "vitest";
import { createPreviewTokenService } from "./preview-token.js";
import { createEventService } from "./events.js";
import { MemoryEventRepository } from "../repo/memory.js";
import { ServiceUnavailableError } from "./join.js";
import type { LiveKitTokenMinter } from "../auth/livekit-minter.js";

function buildEvents() {
  const repo = new MemoryEventRepository();
  let counter = 0;
  return createEventService({
    repo,
    newId: () => `evt-${++counter}`,
    now: () => 1_000_000,
  });
}

function fakeMinter(): LiveKitTokenMinter & {
  calls: Array<{ identity: string; room: string; role: string }>;
} {
  const calls: Array<{ identity: string; room: string; role: string }> = [];
  return {
    calls,
    mint(input) {
      calls.push({ identity: input.identity, room: input.room, role: input.role });
      return `fake-token-${input.identity}`;
    },
  };
}

describe("PreviewTokenService.issue (R17, ADR 0012 D-6)", () => {
  it("live + media.livekitUrl が揃っているときに viewer role の preview token を発行する", async () => {
    const events = buildEvents();
    const created = await events.create({
      title: "test",
      startsAt: "2026-06-19T00:00:00.000Z",
      caption: {
        languages: ["ja"],
        youtubeLanguage: "ja",
        engine: "transcribe",
        customApiEnabled: false,
      },
    });
    await events.setStatus(created.id, "live");
    await events.update(created.id, {
      media: { livekitUrl: "wss://event-X.example.com" },
    } as never);
    const minter = fakeMinter();
    const svc = createPreviewTokenService({ events, liveKitMinter: minter });

    const result = await svc.issue(created.id);

    expect(result.livekitUrl).toBe("wss://event-X.example.com");
    expect(result.room).toBe(created.id);
    expect(result.identity).toMatch(/^preview-[0-9a-f-]+$/);
    expect(result.livekitToken).toBe(`fake-token-${result.identity}`);
    expect(minter.calls).toHaveLength(1);
    // viewer role を確認 (publish 不可、 subscribe 専用)。
    expect(minter.calls[0]?.role).toBe("viewer");
  });

  it("event が live でなければ ServiceUnavailableError を投げる", async () => {
    const events = buildEvents();
    const created = await events.create({
      title: "test",
      startsAt: "2026-06-19T00:00:00.000Z",
      caption: {
        languages: ["ja"],
        youtubeLanguage: "ja",
        engine: "transcribe",
        customApiEnabled: false,
      },
    });
    const svc = createPreviewTokenService({ events, liveKitMinter: fakeMinter() });
    await expect(svc.issue(created.id)).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it("livekitUrl 未設定なら ServiceUnavailableError を投げる", async () => {
    const events = buildEvents();
    const created = await events.create({
      title: "test",
      startsAt: "2026-06-19T00:00:00.000Z",
      caption: {
        languages: ["ja"],
        youtubeLanguage: "ja",
        engine: "transcribe",
        customApiEnabled: false,
      },
    });
    await events.setStatus(created.id, "live");
    const svc = createPreviewTokenService({ events, liveKitMinter: fakeMinter() });
    await expect(svc.issue(created.id)).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it("複数回 issue すると毎回新しい identity が払い出される (複数 preview 同時接続対応)", async () => {
    const events = buildEvents();
    const created = await events.create({
      title: "test",
      startsAt: "2026-06-19T00:00:00.000Z",
      caption: {
        languages: ["ja"],
        youtubeLanguage: "ja",
        engine: "transcribe",
        customApiEnabled: false,
      },
    });
    await events.setStatus(created.id, "live");
    await events.update(created.id, {
      media: { livekitUrl: "wss://event-X.example.com" },
    } as never);
    const svc = createPreviewTokenService({ events, liveKitMinter: fakeMinter() });
    const r1 = await svc.issue(created.id);
    const r2 = await svc.issue(created.id);
    expect(r1.identity).not.toBe(r2.identity);
  });
});
