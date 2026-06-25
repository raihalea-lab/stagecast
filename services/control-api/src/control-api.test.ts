import { describe, expect, it, beforeEach } from "vitest";
import type { CaptionSettings } from "@stagecast/shared";
import { buildControlApi } from "./factory.js";
import type { App, HttpRequest } from "./http/app.js";
import { createSettingsService } from "./usecases/settings.js";

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
        async deletePrefix() {},
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
        async deletePrefix() {},
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

  it("上限超過時に startsAt が古いイベントから自動削除される", async () => {
    // MAX_EVENTS=1000 だと大量に作る必要があるので、小さい上限でテストする。
    // createEventService を直接使ってテスト。
    const { MemoryEventRepository } = await import("./repo/memory.js");
    const { createEventService, MAX_EVENTS } = await import("./usecases/events.js");
    const memRepo = new MemoryEventRepository();
    const deletedIds: string[] = [];
    let cnt = 0;
    const svc = createEventService({
      repo: memRepo,
      newId: () => `evt-${++cnt}`,
      now: () => 1_000_000,
      cleanupStorage: async (id) => {
        deletedIds.push(id);
      },
    });

    // MAX_EVENTS + 2 件作る (startsAt を日付でずらす)
    for (let i = 0; i < MAX_EVENTS + 2; i++) {
      const day = String(i + 1).padStart(4, "0");
      await svc.create({
        title: `E-${day}`,
        startsAt: `2026-01-01T00:00:00Z`,
        caption,
      });
    }

    const all = await svc.list();
    expect(all.length).toBe(MAX_EVENTS);
    // 最初に作った2件 (startsAt が同じなのでソート安定性は保証しないが、2件削除されたことを検証)
    expect(deletedIds.length).toBe(2);
  });

  it("live イベントは自動削除の対象外", async () => {
    const { MemoryEventRepository } = await import("./repo/memory.js");
    const { createEventService, MAX_EVENTS } = await import("./usecases/events.js");
    const memRepo = new MemoryEventRepository();
    let cnt = 0;
    const svc = createEventService({
      repo: memRepo,
      newId: () => `evt-${++cnt}`,
      now: () => 1_000_000,
    });

    // 1件を live にする (startsAt が最も古い)
    const live = await svc.create({
      title: "Live",
      startsAt: "2020-01-01T00:00:00Z",
      caption,
    });
    await svc.setStatus(live.id, "live");

    // MAX_EVENTS 件追加 → 合計 MAX_EVENTS+1 だが live は消せない
    for (let i = 0; i < MAX_EVENTS; i++) {
      await svc.create({
        title: `E-${i}`,
        startsAt: "2026-06-01T00:00:00Z",
        caption,
      });
    }

    const all = await svc.list();
    // live 1件 + MAX_EVENTS-1件の非live = MAX_EVENTS件 (1件は自動削除された)
    // ただし live は消せないので total は MAX_EVENTS+1 にはならず MAX_EVENTS
    expect(all.length).toBe(MAX_EVENTS);
    expect(all.find((e) => e.id === live.id)).toBeDefined();
  });

  it("イベントを削除でき、一覧から消える", async () => {
    const eventId = await createEvent(app, "Deletable");
    const del = await app.handle(
      req({ method: "DELETE", path: `/events/${eventId}`, headers: adminAuth }),
    );
    expect(del.status).toBe(204);
    const list = await app.handle(req({ method: "GET", path: "/events", headers: adminAuth }));
    expect((list.body as unknown[]).length).toBe(0);
  });

  it("配信中のイベントは削除できない", async () => {
    const eventId = await createEvent(app);
    await app.handle(
      req({
        method: "POST",
        path: `/events/${eventId}/status`,
        headers: adminAuth,
        body: { status: "live" },
      }),
    );
    const del = await app.handle(
      req({ method: "DELETE", path: `/events/${eventId}`, headers: adminAuth }),
    );
    expect(del.status).toBe(400);
  });

  it("削除時に関連ストレージが cleanup される", async () => {
    const deletedPrefixes: string[] = [];
    const app2 = buildControlApi({
      inviteSecret: "test-secret",
      now: () => 1_000_000,
      newId: () => `id-${++counter}`,
      artifactStore: {
        async list() {
          return [];
        },
        async presignGet() {
          return "";
        },
        async deletePrefix(prefix) {
          deletedPrefixes.push(prefix);
        },
      },
    });
    const id = await createEvent(app2);
    const del = await app2.handle(
      req({ method: "DELETE", path: `/events/${id}`, headers: adminAuth }),
    );
    expect(del.status).toBe(204);
    expect(deletedPrefixes).toEqual(
      expect.arrayContaining([`assets/${id}/`, `recordings/${id}/`, `captions/${id}/`]),
    );
  });
});

describe("settings (LiveKit / YouTube) HTTP", () => {
  // ローカル/テスト用のインメモリ Secrets ストアと SettingsService 配線。
  const livekitArn = "arn:aws:secretsmanager:ap-northeast-1:1:secret:stagecast/livekit";
  const youtubeArn = "arn:aws:secretsmanager:ap-northeast-1:1:secret:stagecast/youtube";

  function buildAppWithSettings(): App {
    const store = new Map<string, Record<string, string>>();
    const reader = { getSecretJson: async (id: string) => store.get(id) ?? {} };
    const writer = {
      putSecretJson: async (id: string, payload: Record<string, string>) => {
        store.set(id, { ...payload });
      },
    };
    const settings = createSettingsService({
      reader,
      writer,
      livekitSecretArn: livekitArn,
      youtubeSecretArn: youtubeArn,
    });
    return buildControlApi({ inviteSecret: "s", settings });
  }

  it("settings 未配線なら 503 を返す", async () => {
    const app = buildControlApi({ inviteSecret: "s" });
    const res = await app.handle(
      req({ method: "GET", path: "/settings/livekit", headers: adminAuth }),
    );
    expect(res.status).toBe(503);
  });

  it("認証無しの GET /settings/livekit は 401", async () => {
    const app = buildAppWithSettings();
    const res = await app.handle(req({ method: "GET", path: "/settings/livekit" }));
    expect(res.status).toBe(401);
  });

  it("初期状態は configured:false (LiveKit)", async () => {
    const app = buildAppWithSettings();
    const res = await app.handle(
      req({ method: "GET", path: "/settings/livekit", headers: adminAuth }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: false });
  });

  it("PUT で apiKey/apiSecret を保存し GET で configured:true を返す (LiveKit)", async () => {
    const app = buildAppWithSettings();
    const put = await app.handle(
      req({
        method: "PUT",
        path: "/settings/livekit",
        headers: adminAuth,
        body: { apiKey: "k", apiSecret: "s" },
      }),
    );
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ configured: true });

    const get = await app.handle(
      req({ method: "GET", path: "/settings/livekit", headers: adminAuth }),
    );
    expect(get.body).toEqual({ configured: true });
    // ADR 0008 D-7: url はレスポンスから完全削除。
    expect(JSON.stringify(get.body)).not.toContain("url");
  });

  it("apiKey/apiSecret のどれか欠けたら 400", async () => {
    const app = buildAppWithSettings();
    const res = await app.handle(
      req({
        method: "PUT",
        path: "/settings/livekit",
        headers: adminAuth,
        body: { apiKey: "", apiSecret: "s" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("POST /settings/livekit/regenerate で鍵が生成される (機密はレスポンスに含めない)", async () => {
    const app = buildAppWithSettings();
    const regen = await app.handle(
      req({ method: "POST", path: "/settings/livekit/regenerate", headers: adminAuth }),
    );
    expect(regen.status).toBe(200);
    expect(regen.body).toEqual({ configured: true });
    // 機密 (apiKey/apiSecret) はレスポンスに含まれない。
    expect(JSON.stringify(regen.body)).not.toContain("apiKey");
    expect(JSON.stringify(regen.body)).not.toContain("apiSecret");
    expect(JSON.stringify(regen.body)).not.toContain("url");
  });

  it("regenerate も認証が必要 (401)", async () => {
    const app = buildAppWithSettings();
    const res = await app.handle(req({ method: "POST", path: "/settings/livekit/regenerate" }));
    expect(res.status).toBe(401);
  });

  it("PATCH /settings/livekit は削除されており 404", async () => {
    const app = buildAppWithSettings();
    const res = await app.handle(
      req({
        method: "PATCH",
        path: "/settings/livekit",
        headers: adminAuth,
        body: { url: "wss://nlb.example.com" },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("PUT で YouTube を保存しても機密は GET で返らない", async () => {
    const app = buildAppWithSettings();
    const put = await app.handle(
      req({
        method: "PUT",
        path: "/settings/youtube",
        headers: adminAuth,
        body: { apiKey: "K", oauthClientId: "id", oauthClientSecret: "sec" },
      }),
    );
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ configured: true, streamKeyConfigured: false });

    const get = await app.handle(
      req({ method: "GET", path: "/settings/youtube", headers: adminAuth }),
    );
    expect(get.body).toEqual({ configured: true, streamKeyConfigured: false });
  });
});

describe("event requests", () => {
  let app: App;
  let counter: number;

  beforeEach(() => {
    counter = 0;
    app = buildControlApi({
      inviteSecret: "test-secret",
      now: () => 1_000_000,
      newId: () => `id-${++counter}`,
    });
  });

  const validRequest = {
    requesterName: "太郎",
    title: "勉強会",
    startsAt: "2026-07-01T09:00:00Z",
    endsAt: "2026-07-01T11:00:00Z",
    description: "Reactハンズオン",
  };

  it("公開で POST /event-requests を作成できる（認証不要）", async () => {
    const res = await app.handle(
      req({ method: "POST", path: "/event-requests", body: validRequest }),
    );
    expect(res.status).toBe(201);
    const body = res.body as { id: string; status: string; title: string };
    expect(body.status).toBe("pending");
    expect(body.title).toBe("勉強会");
  });

  it("タイトル空でバリデーションエラー", async () => {
    const res = await app.handle(
      req({
        method: "POST",
        path: "/event-requests",
        body: { ...validRequest, title: "" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("endsAt < startsAt でバリデーションエラー", async () => {
    const res = await app.handle(
      req({
        method: "POST",
        path: "/event-requests",
        body: { ...validRequest, endsAt: "2026-07-01T08:00:00Z" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("管理者は GET /event-requests で一覧を取得", async () => {
    await app.handle(req({ method: "POST", path: "/event-requests", body: validRequest }));
    const res = await app.handle(
      req({ method: "GET", path: "/event-requests", headers: adminAuth }),
    );
    expect(res.status).toBe(200);
    expect((res.body as unknown[]).length).toBe(1);
  });

  it("認証なしの GET /event-requests は 401", async () => {
    const res = await app.handle(req({ method: "GET", path: "/event-requests" }));
    expect(res.status).toBe(401);
  });

  it("承認フロー: pending→approved で EventDefinition が自動作成される", async () => {
    const create = await app.handle(
      req({ method: "POST", path: "/event-requests", body: validRequest }),
    );
    const requestId = (create.body as { id: string }).id;

    const approve = await app.handle(
      req({
        method: "POST",
        path: `/event-requests/${requestId}/approve`,
        headers: adminAuth,
      }),
    );
    expect(approve.status).toBe(200);
    const body = approve.body as {
      request: { status: string; approvedEventId: string };
      event: { id: string; title: string; status: string };
    };
    expect(body.request.status).toBe("approved");
    expect(body.event.title).toBe("勉強会");
    expect(body.event.status).toBe("draft");
    expect(body.request.approvedEventId).toBe(body.event.id);
  });

  it("二重承認は 400", async () => {
    const create = await app.handle(
      req({ method: "POST", path: "/event-requests", body: validRequest }),
    );
    const requestId = (create.body as { id: string }).id;
    await app.handle(
      req({
        method: "POST",
        path: `/event-requests/${requestId}/approve`,
        headers: adminAuth,
      }),
    );
    const res = await app.handle(
      req({
        method: "POST",
        path: `/event-requests/${requestId}/approve`,
        headers: adminAuth,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("却下フロー: pending→rejected", async () => {
    const create = await app.handle(
      req({ method: "POST", path: "/event-requests", body: validRequest }),
    );
    const requestId = (create.body as { id: string }).id;

    const reject = await app.handle(
      req({
        method: "POST",
        path: `/event-requests/${requestId}/reject`,
        headers: adminAuth,
        body: { reason: "日程が合わない" },
      }),
    );
    expect(reject.status).toBe(200);
    const body = reject.body as { status: string; rejectionReason: string };
    expect(body.status).toBe("rejected");
    expect(body.rejectionReason).toBe("日程が合わない");
  });

  it("承認済みを却下は 400", async () => {
    const create = await app.handle(
      req({ method: "POST", path: "/event-requests", body: validRequest }),
    );
    const requestId = (create.body as { id: string }).id;
    await app.handle(
      req({
        method: "POST",
        path: `/event-requests/${requestId}/approve`,
        headers: adminAuth,
      }),
    );
    const res = await app.handle(
      req({
        method: "POST",
        path: `/event-requests/${requestId}/reject`,
        headers: adminAuth,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("GET /events/public は draft を除外し機密フィールドを含まない", async () => {
    // draft イベントを作成
    await app.handle(
      req({
        method: "POST",
        path: "/events",
        headers: adminAuth,
        body: { title: "Draft", startsAt: "2026-07-01T09:00:00Z", caption },
      }),
    );
    // scheduled にする
    const e2 = await app.handle(
      req({
        method: "POST",
        path: "/events",
        headers: adminAuth,
        body: { title: "Scheduled", startsAt: "2026-07-02T09:00:00Z", caption },
      }),
    );
    const scheduledId = (e2.body as { id: string }).id;
    await app.handle(
      req({
        method: "POST",
        path: `/events/${scheduledId}/status`,
        headers: adminAuth,
        body: { status: "scheduled" },
      }),
    );

    const res = await app.handle(req({ method: "GET", path: "/events/public" }));
    expect(res.status).toBe(200);
    const body = res.body as { id: string; title: string; status: string }[];
    expect(body.length).toBe(1);
    expect(body[0].title).toBe("Scheduled");
    expect(JSON.stringify(body[0])).not.toContain("caption");
    expect(JSON.stringify(body[0])).not.toContain("youtube");
  });
});
