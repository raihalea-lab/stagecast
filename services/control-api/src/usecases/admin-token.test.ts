import { describe, expect, it } from "vitest";
import { createAdminTokenService } from "./admin-token.js";
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

function fakeMinter(): LiveKitTokenMinter & { calls: Array<{ identity: string; room: string; role: string }> } {
  const calls: Array<{ identity: string; room: string; role: string }> = [];
  return {
    calls,
    mint(input) {
      calls.push({ identity: input.identity, room: input.room, role: input.role });
      return `fake-token-${input.identity}`;
    },
  };
}

describe("AdminTokenService.issue (R16, ADR 0012 D-4)", () => {
  it("live + media.livekitUrl が揃っているときに admin token を発行する", async () => {
    const events = buildEvents();
    const created = await events.create({
      title: "test",
      startsAt: "2026-06-19T00:00:00.000Z",
      caption: { languages: ["ja"], youtubeLanguage: "ja", engine: "transcribe", customApiEnabled: false },
    });
    await events.setStatus(created.id, "live");
    // events.update の型は CreateEventInput ベースで media を含まないが、 実装は spread で
    // patch を受け入れるので as never で test 用に通す (既存 egress.test.ts と同じパターン)。
    await events.update(created.id, { media: { livekitUrl: "wss://event-X.example.com" } } as never);
    const minter = fakeMinter();
    const svc = createAdminTokenService({ events, liveKitMinter: minter });

    const result = await svc.issue(created.id);

    expect(result.livekitUrl).toBe("wss://event-X.example.com");
    expect(result.room).toBe(created.id);
    expect(result.identity).toMatch(/^admin-[0-9a-f-]+$/);
    expect(result.livekitToken).toBe(`fake-token-${result.identity}`);
    expect(minter.calls).toHaveLength(1);
    expect(minter.calls[0]?.role).toBe("admin");
  });

  it("event が live でなければ ServiceUnavailableError を投げる", async () => {
    const events = buildEvents();
    const created = await events.create({
      title: "test",
      startsAt: "2026-06-19T00:00:00.000Z",
      caption: { languages: ["ja"], youtubeLanguage: "ja", engine: "transcribe", customApiEnabled: false },
    });
    // status は draft のまま
    const svc = createAdminTokenService({ events, liveKitMinter: fakeMinter() });
    await expect(svc.issue(created.id)).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it("livekitUrl 未設定 (EventMediaStack 起動中) なら ServiceUnavailableError を投げる", async () => {
    const events = buildEvents();
    const created = await events.create({
      title: "test",
      startsAt: "2026-06-19T00:00:00.000Z",
      caption: { languages: ["ja"], youtubeLanguage: "ja", engine: "transcribe", customApiEnabled: false },
    });
    await events.setStatus(created.id, "live");
    // media は設定しない
    const svc = createAdminTokenService({ events, liveKitMinter: fakeMinter() });
    await expect(svc.issue(created.id)).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it("issueStageToken は Cognito userId を identity に使い { token, livekitUrl, expiresAt } を返す", async () => {
    const events = buildEvents();
    const created = await events.create({
      title: "test",
      startsAt: "2026-06-19T00:00:00.000Z",
      caption: { languages: ["ja"], youtubeLanguage: "ja", engine: "transcribe", customApiEnabled: false },
    });
    await events.setStatus(created.id, "live");
    await events.update(created.id, { media: { livekitUrl: "wss://event-X.example.com" } } as never);
    const minter = fakeMinter();
    const svc = createAdminTokenService({ events, liveKitMinter: minter });

    const result = await svc.issueStageToken(created.id, "cognito-user-abc");

    expect(result.token).toBe("fake-token-admin-cognito-user-abc");
    expect(result.livekitUrl).toBe("wss://event-X.example.com");
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(minter.calls[0]?.identity).toBe("admin-cognito-user-abc");
  });

  it("複数回 issue すると毎回新しい identity が払い出される (複数 admin 同時接続対応)", async () => {
    const events = buildEvents();
    const created = await events.create({
      title: "test",
      startsAt: "2026-06-19T00:00:00.000Z",
      caption: { languages: ["ja"], youtubeLanguage: "ja", engine: "transcribe", customApiEnabled: false },
    });
    await events.setStatus(created.id, "live");
    // events.update の型は CreateEventInput ベースで media を含まないが、 実装は spread で
    // patch を受け入れるので as never で test 用に通す (既存 egress.test.ts と同じパターン)。
    await events.update(created.id, { media: { livekitUrl: "wss://event-X.example.com" } } as never);
    const svc = createAdminTokenService({ events, liveKitMinter: fakeMinter() });

    const r1 = await svc.issue(created.id);
    const r2 = await svc.issue(created.id);

    expect(r1.identity).not.toBe(r2.identity);
  });
});
