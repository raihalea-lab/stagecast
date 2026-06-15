import { describe, expect, it, beforeEach } from "vitest";
import type { CaptionSettings } from "@stagecast/shared";
import { buildControlApi } from "./factory.js";
import type { App, HttpRequest } from "./http/app.js";

const caption: CaptionSettings = {
  languages: ["ja", "en"],
  youtubeLanguage: "ja",
  engine: "transcribe",
  customApiEnabled: false,
};

const adminAuth = { authorization: "Bearer fake:admin-1:admin@example.com" };

function req(partial: Partial<HttpRequest> & Pick<HttpRequest, "method" | "path">): HttpRequest {
  return { headers: {}, ...partial };
}

/** イベントを作成して id を返す (招待発行は存在するイベントが前提)。 */
async function createEvent(app: App, title = "E"): Promise<string> {
  const res = await app.handle(
    req({
      method: "POST",
      path: "/events",
      headers: adminAuth,
      body: { title, startsAt: "2026-07-01T09:00:00Z", caption },
    }),
  );
  return (res.body as { id: string }).id;
}

describe("control-api integration (in-memory)", () => {
  let app: App;
  let counter: number;

  beforeEach(() => {
    counter = 0;
    // 決定的な ID/時刻でテストする
    app = buildControlApi({
      inviteSecret: "test-secret",
      now: () => 1_000_000,
      newId: () => `id-${++counter}`,
    });
  });

  it("rejects unauthenticated admin calls (F-12)", async () => {
    const res = await app.handle(req({ method: "GET", path: "/events" }));
    expect(res.status).toBe(401);
  });

  it("creates, gets, lists and updates an event", async () => {
    const create = await app.handle(
      req({
        method: "POST",
        path: "/events",
        headers: adminAuth,
        body: { title: "Tech Conf", startsAt: "2026-07-01T09:00:00Z", caption },
      }),
    );
    expect(create.status).toBe(201);
    const created = create.body as { id: string; status: string };
    expect(created.status).toBe("draft");

    const get = await app.handle(
      req({ method: "GET", path: `/events/${created.id}`, headers: adminAuth }),
    );
    expect(get.status).toBe(200);

    const list = await app.handle(req({ method: "GET", path: "/events", headers: adminAuth }));
    expect((list.body as unknown[]).length).toBe(1);

    const patch = await app.handle(
      req({
        method: "PATCH",
        path: `/events/${created.id}`,
        headers: adminAuth,
        body: { title: "Renamed" },
      }),
    );
    expect((patch.body as { title: string }).title).toBe("Renamed");
  });

  it("rejects invalid caption settings (youtubeLanguage not in languages)", async () => {
    const res = await app.handle(
      req({
        method: "POST",
        path: "/events",
        headers: adminAuth,
        body: {
          title: "Bad",
          startsAt: "2026-07-01T09:00:00Z",
          caption: { ...caption, youtubeLanguage: "en", languages: ["ja"] },
        },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("enforces lifecycle transitions (draft->live->ended)", async () => {
    const { id } = (
      await app.handle(
        req({
          method: "POST",
          path: "/events",
          headers: adminAuth,
          body: { title: "E", startsAt: "2026-07-01T09:00:00Z", caption },
        }),
      )
    ).body as { id: string };

    const toEnded = await app.handle(
      req({
        method: "POST",
        path: `/events/${id}/status`,
        headers: adminAuth,
        body: { status: "ended" },
      }),
    );
    expect(toEnded.status).toBe(400); // draft -> ended は不可

    const toLive = await app.handle(
      req({
        method: "POST",
        path: `/events/${id}/status`,
        headers: adminAuth,
        body: { status: "live" },
      }),
    );
    expect((toLive.body as { status: string }).status).toBe("live");
  });

  it("toggles speaker visibility (F-4, 5.3)", async () => {
    const { id } = (
      await app.handle(
        req({
          method: "POST",
          path: "/events",
          headers: adminAuth,
          body: { title: "E", startsAt: "2026-07-01T09:00:00Z", caption },
        }),
      )
    ).body as { id: string };

    const live = await app.handle(
      req({
        method: "POST",
        path: `/events/${id}/presentation/speakers`,
        headers: adminAuth,
        body: { speakerId: "spk-1", visibility: "live" },
      }),
    );
    expect(live.status).toBe(200);
    const state = live.body as { speakers: { speakerId: string; visibility: string }[] };
    expect(state.speakers[0]).toMatchObject({ speakerId: "spk-1", visibility: "live" });
  });

  it("不正な発表者状態/スライド入力は 400 (合成を壊さない)", async () => {
    const { id } = (
      await app.handle(
        req({
          method: "POST",
          path: "/events",
          headers: adminAuth,
          body: { title: "E", startsAt: "2026-07-01T09:00:00Z", caption },
        }),
      )
    ).body as { id: string };

    const badVisibility = await app.handle(
      req({
        method: "POST",
        path: `/events/${id}/presentation/speakers`,
        headers: adminAuth,
        body: { speakerId: "spk-1", visibility: "spotlight" },
      }),
    );
    expect(badVisibility.status).toBe(400);

    const badPage = await app.handle(
      req({
        method: "POST",
        path: `/events/${id}/presentation/slide`,
        headers: adminAuth,
        body: { slideSource: "uploaded", slidePage: -2 },
      }),
    );
    expect(badPage.status).toBe(400);

    const badSource = await app.handle(
      req({
        method: "POST",
        path: `/events/${id}/presentation/slide`,
        headers: adminAuth,
        body: { slideSource: "webcam" },
      }),
    );
    expect(badSource.status).toBe(400);
  });

  it("issues, verifies, revokes and reissues invite tokens (4.1)", async () => {
    const eventId = await createEvent(app);
    const issued = await app.handle(
      req({
        method: "POST",
        path: `/events/${eventId}/invites`,
        headers: adminAuth,
        body: { role: "moderator", ttlSec: 3600 },
      }),
    );
    expect(issued.status).toBe(201);
    const { token, jti } = issued.body as { token: string; jti: string };

    // 公開エンドポイントで検証 (認証不要)
    const verify = await app.handle(
      req({ method: "POST", path: "/invites/verify", body: { token } }),
    );
    expect(verify.status).toBe(200);
    expect(verify.body).toMatchObject({ valid: true, role: "moderator", eventId });

    // 失効させると古いトークンは無効
    await app.handle(req({ method: "POST", path: `/invites/${jti}/revoke`, headers: adminAuth }));
    const afterRevoke = await app.handle(
      req({ method: "POST", path: "/invites/verify", body: { token } }),
    );
    expect(afterRevoke.status).toBe(401);
    expect(afterRevoke.body).toMatchObject({ valid: false, reason: "revoked" });

    // 再発行すると新トークンは有効、role を引き継ぐ
    const reissued = await app.handle(
      req({
        method: "POST",
        path: `/invites/${jti}/reissue`,
        headers: adminAuth,
        body: { ttlSec: 3600 },
      }),
    );
    const { token: newToken } = reissued.body as { token: string };
    const verifyNew = await app.handle(
      req({ method: "POST", path: "/invites/verify", body: { token: newToken } }),
    );
    expect(verifyNew.body).toMatchObject({ valid: true, role: "moderator" });

    // 旧トークンは version 不一致で無効のまま
    const verifyOld = await app.handle(
      req({ method: "POST", path: "/invites/verify", body: { token } }),
    );
    expect(verifyOld.status).toBe(401);
  });

  it("存在しない招待の再発行は 404 (内部エラーにしない)", async () => {
    const res = await app.handle(
      req({
        method: "POST",
        path: "/invites/does-not-exist/reissue",
        headers: adminAuth,
        body: { ttlSec: 3600 },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("配信成果物のダウンロード URL を一覧する (N1)", async () => {
    const app2 = buildControlApi({
      inviteSecret: "test-secret",
      artifactStore: {
        async list(prefix) {
          return prefix.startsWith("recordings/") ? [{ key: `${prefix}rec.mp4`, size: 10 }] : [];
        },
        async presignGet(key) {
          return `https://signed/${key}`;
        },
      },
    });
    const res = await app2.handle(
      req({ method: "GET", path: "/events/evt-9/artifacts", headers: adminAuth }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      artifacts: [{ kind: "recording", name: "rec.mp4", downloadUrl: expect.any(String) }],
    });
  });

  it("成果物一覧も認証必須 (F-12)", async () => {
    const app2 = buildControlApi({
      inviteSecret: "test-secret",
      artifactStore: {
        async list() {
          return [];
        },
        async presignGet() {
          return "";
        },
      },
    });
    const res = await app2.handle(req({ method: "GET", path: "/events/evt-9/artifacts" }));
    expect(res.status).toBe(401);
  });

  // 入力バリデーション強化 (公開境界の堅牢化)。不正入力は 500 でなく 400 を返す。
  const createBody = (extra: Record<string, unknown>) =>
    req({
      method: "POST",
      path: "/events",
      headers: adminAuth,
      body: { title: "OK", startsAt: "2026-07-01T09:00:00Z", caption, ...extra },
    });

  it("空タイトル/非文字列タイトルは 400 (500 でなく)", async () => {
    expect((await app.handle(createBody({ title: "  " }))).status).toBe(400);
    expect((await app.handle(createBody({ title: 123 }))).status).toBe(400);
  });

  it("長すぎるタイトルは 400", async () => {
    expect((await app.handle(createBody({ title: "x".repeat(201) }))).status).toBe(400);
  });

  it("不正な startsAt は 400", async () => {
    expect((await app.handle(createBody({ startsAt: "not-a-date" }))).status).toBe(400);
    expect((await app.handle(createBody({ startsAt: 0 }))).status).toBe(400);
  });

  it("endsAt が startsAt より前なら 400", async () => {
    const res = await app.handle(
      createBody({ startsAt: "2026-07-01T10:00:00Z", endsAt: "2026-07-01T09:00:00Z" }),
    );
    expect(res.status).toBe(400);
  });

  it("招待発行: 不正な role / 範囲外 ttlSec は 400", async () => {
    const eventId = await createEvent(app);
    const issueBody = (body: Record<string, unknown>) =>
      req({ method: "POST", path: `/events/${eventId}/invites`, headers: adminAuth, body });
    expect((await app.handle(issueBody({ role: "admin", ttlSec: 3600 }))).status).toBe(400);
    expect((await app.handle(issueBody({ role: "speaker", ttlSec: 1 }))).status).toBe(400);
    expect((await app.handle(issueBody({ role: "speaker", ttlSec: 8 * 24 * 3600 }))).status).toBe(
      400,
    );
    expect((await app.handle(issueBody({ role: "speaker", ttlSec: "abc" }))).status).toBe(400);
    // 正常系は 201。
    expect((await app.handle(issueBody({ role: "speaker", ttlSec: 3600 }))).status).toBe(201);
  });

  it("存在しないイベントへの招待発行は 404", async () => {
    const res = await app.handle(
      req({
        method: "POST",
        path: "/events/does-not-exist/invites",
        headers: adminAuth,
        body: { role: "speaker", ttlSec: 3600 },
      }),
    );
    expect(res.status).toBe(404);
  });
});
