import { describe, expect, it, beforeEach } from "vitest";
import { decodeRoomMetadata } from "@stagecast/shared";
import type { CaptionSettings } from "@stagecast/shared";
import { buildControlApi } from "./factory.js";
import type { App, HttpRequest } from "./http/app.js";
import { createSettingsService } from "./usecases/settings.js";
import type { IssuedInvite } from "./usecases/invites.js";

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

  it("招待 URL はロールごとに 1 本で、取得のたびに同じ URL が返り、期限はイベント終了に追従する (ADR 0029)", async () => {
    const eventId = await createEvent(app);
    const list = () =>
      app.handle(req({ method: "GET", path: `/events/${eventId}/invites`, headers: adminAuth }));

    const first = await list();
    expect(first.status).toBe(200);
    const invites = (first.body as { invites: IssuedInvite[] }).invites;
    expect(invites.map((i) => i.role).sort()).toEqual(["moderator", "speaker"]);

    // endsAt 未設定 → 開始 + 2h、その 1h 後まで有効 (発行時刻に依存しない)。
    const expectedExp = Date.parse("2026-07-01T12:00:00Z") / 1000;
    for (const inv of invites) expect(inv.expiresAtSec).toBe(expectedExp);

    // 2 回目も新規発行にならず、同じ URL 文字列が返る。
    const second = await list();
    expect((second.body as { invites: IssuedInvite[] }).invites).toEqual(invites);

    // GET で返したトークンで入室検証が通る。
    const speaker = invites.find((i) => i.role === "speaker")!;
    const ok = await app.handle(
      req({ method: "POST", path: "/invites/verify", body: { token: speaker.token } }),
    );
    expect((ok.body as { valid: boolean }).valid).toBe(true);

    // 再発行すると URL が変わり、古いトークンは弾かれる。期限は変わらずイベント終了に揃う。
    const reissued = await app.handle(
      req({ method: "POST", path: `/invites/${speaker.jti}/reissue`, headers: adminAuth }),
    );
    expect(reissued.status).toBe(201);
    const next = reissued.body as IssuedInvite;
    expect(next.url).not.toBe(speaker.url);
    expect(next.expiresAtSec).toBe(expectedExp);
    const stale = await app.handle(
      req({ method: "POST", path: "/invites/verify", body: { token: speaker.token } }),
    );
    expect((stale.body as { valid: boolean; reason?: string }).reason).toBe("stale-version");

    // 再発行後の GET も再発行結果と同じ URL を返す (再発行のたびに増えない)。
    const third = (await list()).body as { invites: IssuedInvite[] };
    expect(third.invites).toHaveLength(2);
    expect(third.invites.find((i) => i.role === "speaker")?.url).toBe(next.url);

    // 失効させたロールは、勝手に作り直さず「無し」になる (revoke が rotate にならない)。
    await app.handle(
      req({ method: "POST", path: `/invites/${speaker.jti}/revoke`, headers: adminAuth }),
    );
    const afterRevoke = (await list()).body as { invites: IssuedInvite[] };
    expect(afterRevoke.invites.map((i) => i.role)).toEqual(["moderator"]);

    const missing = await app.handle(
      req({ method: "GET", path: "/events/nope/invites", headers: adminAuth }),
    );
    expect(missing.status).toBe(404);
  });

  it("投影状態の正をサーバーに置く: デッキとページを保存して読み戻せる (ADR 0022 D-1)", async () => {
    const eventId = await createEvent(app);
    const inviteFor = async (role: "moderator" | "speaker") => {
      const res = await app.handle(
        req({
          method: "POST",
          path: `/events/${eventId}/invites`,
          headers: adminAuth,
          body: { role, ttlSec: 3600 },
        }),
      );
      return (res.body as { token: string }).token;
    };
    const moderator = await inviteFor("moderator");
    const speaker = await inviteFor("speaker");
    const deck = { assetId: "a-1", filename: "deck.pdf", pageCount: 12 };

    // モデレーターがデッキを投影する。
    const put = await app.handle(
      req({
        method: "POST",
        path: "/stage/presentation/slide",
        body: { inviteToken: moderator, slideSource: "uploaded", slidePage: 3, deck },
      }),
    );
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ slideSource: "uploaded", slidePage: 3, deck });

    // 後から入った登壇者は状態を「読む」だけで現在の投影が分かる (配り直しが要らない)。
    const read = await app.handle(
      req({ method: "POST", path: "/stage/presentation/state", body: { inviteToken: speaker } }),
    );
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ slideSource: "uploaded", slidePage: 3, deck });

    // 登壇者もめくれる (PR #218 の価値を残す)。
    const turned = await app.handle(
      req({
        method: "POST",
        path: "/stage/presentation/slide",
        body: { inviteToken: speaker, slideSource: "uploaded", slidePage: 4, deck },
      }),
    );
    expect(turned.status).toBe(200);
    expect(turned.body).toMatchObject({ slidePage: 4 });

    // 投影解除するとデッキも消える (残すと解除済みの PDF を後続クライアントが読む)。
    const cleared = await app.handle(
      req({
        method: "POST",
        path: "/stage/presentation/slide",
        body: { inviteToken: moderator },
      }),
    );
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ slideSource: undefined, deck: undefined });
  });

  it("レイアウトの正をサーバーに置く: 保存して読み戻せる (ADR 0025 D-1)", async () => {
    const eventId = await createEvent(app);
    const inviteFor = async (role: "moderator" | "speaker") => {
      const res = await app.handle(
        req({
          method: "POST",
          path: `/events/${eventId}/invites`,
          headers: adminAuth,
          body: { role, ttlSec: 3600 },
        }),
      );
      return (res.body as { token: string }).token;
    };
    const moderator = await inviteFor("moderator");
    const speaker = await inviteFor("speaker");

    const put = await app.handle(
      req({
        method: "POST",
        path: "/stage/presentation/layout",
        body: { inviteToken: moderator, layout: "spotlight", focusIdentity: "speaker-1" },
      }),
    );
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ layout: "spotlight", focusIdentity: "speaker-1" });

    // 2 枚目の管理ウィンドウ (後から読む人) が同じ状態を見る。これがマルチウィンドウの要。
    const read = await app.handle(
      req({ method: "POST", path: "/stage/presentation/state", body: { inviteToken: speaker } }),
    );
    expect(read.body).toMatchObject({ layout: "spotlight", focusIdentity: "speaker-1" });

    // grid に戻したら主役も消える (残すと次に spotlight にしたとき古い人が主役になる)。
    const back = await app.handle(
      req({
        method: "POST",
        path: "/stage/presentation/layout",
        body: { inviteToken: moderator, layout: "grid", focusIdentity: "speaker-1" },
      }),
    );
    expect(back.body).toMatchObject({ layout: "grid", focusIdentity: undefined });

    // 登壇者は変えられない。
    const denied = await app.handle(
      req({
        method: "POST",
        path: "/stage/presentation/layout",
        body: { inviteToken: speaker, layout: "pip" },
      }),
    );
    expect(denied.status).toBe(403);

    // 不正な値は保存しない (composer が知らないレイアウトで壊れる)。
    const bad = await app.handle(
      req({
        method: "POST",
        path: "/stage/presentation/layout",
        body: { inviteToken: moderator, layout: "cinema" },
      }),
    );
    expect(bad.status).toBe(400);
  });

  it("デッキ URL は moderator にだけ出す (資料ダウンロードの制限を迂回させない)", async () => {
    const eventId = await createEvent(app);
    const inviteFor = async (role: "moderator" | "speaker") => {
      const res = await app.handle(
        req({
          method: "POST",
          path: `/events/${eventId}/invites`,
          headers: adminAuth,
          body: { role, ttlSec: 3600 },
        }),
      );
      return (res.body as { token: string }).token;
    };
    const moderator = await inviteFor("moderator");
    const speaker = await inviteFor("speaker");
    await app.handle(
      req({
        method: "POST",
        path: "/stage/presentation/slide",
        body: {
          inviteToken: moderator,
          slideSource: "uploaded",
          slidePage: 1,
          deck: { assetId: "a-1", filename: "deck.pdf", pageCount: 3 },
        },
      }),
    );

    const asSpeaker = await app.handle(
      req({ method: "POST", path: "/stage/presentation/state", body: { inviteToken: speaker } }),
    );
    // ページを送るのに必要な情報は渡すが、PDF そのものには手が届かない。
    expect(asSpeaker.body).toMatchObject({ slidePage: 1, deck: { pageCount: 3 } });
    expect((asSpeaker.body as { deckUrl?: string }).deckUrl).toBeUndefined();
  });

  it("投影状態を room metadata に載せる (composer が読む唯一の経路, ADR 0022 D-1)", async () => {
    const published: { eventId: string; metadata: string }[] = [];
    const metaApp = buildControlApi({
      auth: {
        async verify() {
          return { sub: "admin-1", email: "a@example.com" };
        },
      },
      roomMetadata: {
        async publish(eventId, metadata) {
          published.push({ eventId, metadata });
        },
      },
    });
    const eventId = await createEvent(metaApp);
    const issued = await metaApp.handle(
      req({
        method: "POST",
        path: `/events/${eventId}/invites`,
        headers: adminAuth,
        body: { role: "moderator", ttlSec: 3600 },
      }),
    );
    const inviteToken = (issued.body as { token: string }).token;
    const deck = { assetId: "a-1", filename: "deck.pdf", pageCount: 5 };

    await metaApp.handle(
      req({
        method: "POST",
        path: "/stage/presentation/slide",
        body: { inviteToken, slideSource: "uploaded", slidePage: 2, deck },
      }),
    );
    expect(published).toHaveLength(1);
    expect(published[0]?.eventId).toBe(eventId);
    expect(decodeRoomMetadata(published[0]?.metadata)).toMatchObject({
      slideSource: "uploaded",
      slidePage: 2,
      deck,
    });

    // moderator が状態を読むと metadata を貼り直す (署名の更新をここに寄せている)。
    await metaApp.handle(
      req({ method: "POST", path: "/stage/presentation/state", body: { inviteToken } }),
    );
    expect(published).toHaveLength(2);

    // 投影解除は空の状態を載せる (composer が投影を降ろせる)。
    // JSON は undefined のキーを落とすので、版だけが残るのが正しい形。
    await metaApp.handle(
      req({ method: "POST", path: "/stage/presentation/slide", body: { inviteToken } }),
    );
    expect(decodeRoomMetadata(published[2]?.metadata)).toEqual({ v: 1 });
  });

  it("古いページ送りは捨てる (ADR 0022 D-2)", async () => {
    // 同一イベントに 2 人が同時にめくると書き込みが前後しうる。now() は
    // テストの固定時刻なので、repo を直接叩いて前後関係だけを検証する。
    const { MemoryPresentationRepository } = await import("./repo/memory.js");
    const repo = new MemoryPresentationRepository();
    const deck = { assetId: "a", filename: "d.pdf", pageCount: 9 };
    await repo.setSlide("e1", {
      slideSource: "uploaded",
      slidePage: 5,
      deck,
      slideUpdatedAtMs: 2000,
    });
    const stale = await repo.setSlide("e1", {
      slideSource: "uploaded",
      slidePage: 2,
      deck,
      slideUpdatedAtMs: 1000,
    });
    expect(stale.slidePage).toBe(5);

    const fresh = await repo.setSlide("e1", {
      slideSource: "uploaded",
      slidePage: 6,
      deck,
      slideUpdatedAtMs: 3000,
    });
    expect(fresh.slidePage).toBe(6);
  });

  it("投影状態の入力検証 (ADR 0022 D-1)", async () => {
    const eventId = await createEvent(app);
    const issued = await app.handle(
      req({
        method: "POST",
        path: `/events/${eventId}/invites`,
        headers: adminAuth,
        body: { role: "moderator", ttlSec: 3600 },
      }),
    );
    const inviteToken = (issued.body as { token: string }).token;
    const post = (body: Record<string, unknown>) =>
      app.handle(req({ method: "POST", path: "/stage/presentation/slide", body }));

    // assetId / filename はそのまま S3 キーに組み立てられる。区切り文字を通すと
    // 他イベントの資料を指す参照を保存できてしまう。
    const traversal = await post({
      inviteToken,
      slideSource: "uploaded",
      deck: { assetId: "../other", filename: "deck.pdf", pageCount: 1 },
    });
    expect(traversal.status).toBe(400);

    const slash = await post({
      inviteToken,
      slideSource: "uploaded",
      deck: { assetId: "a", filename: "sub/deck.pdf", pageCount: 1 },
    });
    expect(slash.status).toBe(400);

    const badCount = await post({
      inviteToken,
      slideSource: "uploaded",
      deck: { assetId: "a", filename: "deck.pdf", pageCount: 0 },
    });
    expect(badCount.status).toBe(400);

    // 画面共有中にデッキ参照が残ると、composer がどちらを出すか決められない。
    const wrongSource = await post({
      inviteToken,
      slideSource: "screen-share",
      deck: { assetId: "a", filename: "deck.pdf", pageCount: 1 },
    });
    expect(wrongSource.status).toBe(400);
  });

  it("投影状態は招待トークンが要る (ADR 0022 D-1)", async () => {
    const anon = await app.handle(
      req({ method: "POST", path: "/stage/presentation/state", body: { inviteToken: "bogus" } }),
    );
    expect(anon.status).toBe(401);
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

  // 終了済みを MAX_EVENTS+2 件そろえるため create + 状態遷移を 1000 回超え回す。
  // 並列負荷下では既定 5s に収まらない。
  it(
    "上限超過時に終了済みイベントだけが startsAt の古い順に削除される",
    { timeout: 60_000 },
    async () => {
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

      // 終了済みを上限 +2 件。startsAt は 1 分ずつ新しくしていくので先頭 2 件が最古。
      const ended: string[] = [];
      for (let i = 0; i < MAX_EVENTS + 2; i++) {
        const e = await svc.create({
          title: `Ended-${i}`,
          startsAt: new Date(Date.UTC(2020, 0, 1) + i * 60_000).toISOString(),
          caption,
        });
        await svc.setStatus(e.id, "live");
        await svc.setStatus(e.id, "ended");
        ended.push(e.id);
      }
      // 未終了 2 件。ended より startsAt が古いが、終了していないので消してはいけない。
      const live = await svc.create({ title: "Live", startsAt: "2019-01-01T00:00:00Z", caption });
      await svc.setStatus(live.id, "live");
      const draft = await svc.create({
        title: "Draft",
        startsAt: "2019-01-02T00:00:00Z",
        caption,
      });

      const all = await svc.list();
      // 消えたのは終了済みの古い 2 件だけ。未終了は件数にも数えないので巻き込まれない。
      expect(deletedIds).toEqual([ended[0], ended[1]]);
      expect(all.filter((e) => e.status === "ended").length).toBe(MAX_EVENTS);
      expect(all.find((e) => e.id === live.id)).toBeDefined();
      expect(all.find((e) => e.id === draft.id)).toBeDefined();
      expect(all.length).toBe(MAX_EVENTS + 2);
    },
  );

  // 未終了イベントだけで上限に達しても消さない (ソフトキャップ)。予定中のイベントが
  // 押し出されて消えるのが一番避けたい事故なので、上限超過を許す方を選んでいる。
  it("未終了イベントは上限を超えても自動削除されない", { timeout: 30_000 }, async () => {
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

    const scheduled = await svc.create({
      title: "Scheduled",
      startsAt: "2019-01-01T00:00:00Z",
      caption,
    });
    await svc.setStatus(scheduled.id, "scheduled");
    for (let i = 0; i < MAX_EVENTS + 2; i++) {
      await svc.create({ title: `Draft-${i}`, startsAt: "2026-06-01T00:00:00Z", caption });
    }

    const all = await svc.list();
    expect(all.length).toBe(MAX_EVENTS + 3);
    expect(deletedIds).toEqual([]);
    expect(all.find((e) => e.id === scheduled.id)).toBeDefined();
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
      expect.arrayContaining([`recordings/${id}/`, `captions/${id}/`]),
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

  it("GET /events/public は全ステータスを返し機密フィールドを含まない", async () => {
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
    expect(body.length).toBe(2);
    expect(body.map((e) => e.title).sort()).toEqual(["Draft", "Scheduled"]);
    expect(JSON.stringify(body)).not.toContain("caption");
    expect(JSON.stringify(body)).not.toContain("youtube");
  });
});

describe("stage routes (invite-token 認証, Phase 3/4)", () => {
  let app: App;
  let counter: number;

  beforeEach(() => {
    counter = 0;
    app = buildControlApi({
      inviteSecret: "test-secret",
      now: () => 1_000_000,
      newId: () => `id-${++counter}`,
      artifactStore: {
        async list() {
          return [];
        },
        async presignGet(key) {
          return `https://signed/${key}`;
        },
        async deletePrefix() {},
      },
    });
  });

  async function moderatorToken(): Promise<string> {
    const eventId = await createEvent(app);
    const issued = await app.handle(
      req({
        method: "POST",
        path: `/events/${eventId}/invites`,
        headers: adminAuth,
        body: { role: "moderator", ttlSec: 3600 },
      }),
    );
    return (issued.body as { token: string }).token;
  }

  it("プリセット一覧 (POST /stage/presets/list) は作成と衝突せず、空のまま", async () => {
    const inviteToken = await moderatorToken();
    const list = () =>
      app.handle(req({ method: "POST", path: "/stage/presets/list", body: { inviteToken } }));
    expect((await list()).body).toEqual({ presets: [] });
    // 一覧を 2 回呼んでもゴミプリセットが作られない (旧実装は POST が作成分岐に吸われた)。
    expect((await list()).body).toEqual({ presets: [] });

    const created = await app.handle(
      req({
        method: "POST",
        path: "/stage/presets",
        body: {
          inviteToken,
          label: "L",
          config: { kind: "banner", text: "hi", position: "bottom" },
        },
      }),
    );
    expect(created.status).toBe(201);
    expect((await list()).body).toMatchObject({ presets: [{ label: "L" }] });
  });

  it("config の無いプリセット作成は 400", async () => {
    const inviteToken = await moderatorToken();
    const res = await app.handle(
      req({ method: "POST", path: "/stage/presets", body: { inviteToken, label: "x" } }),
    );
    expect(res.status).toBe(400);
  });

  it("download-url はライブラリ未登録のキーを presign しない", async () => {
    const inviteToken = await moderatorToken();
    const res = await app.handle(
      req({
        method: "POST",
        path: "/stage/assets/download-url",
        body: { inviteToken, assetKey: "recordings/other-event/egress.mp4" },
      }),
    );
    expect(res.status).toBe(404);
  });
});
