import { describe, expect, it } from "vitest";
import {
  MATERIALS_CONTEXT_CHAR_LIMIT,
  MATERIAL_CHAR_LIMIT,
  materialsContextKey,
  parseMaterialKey,
  type MaterialsContext,
} from "@stagecast/shared";
import { buildMaterialsContext, normalizeText } from "./build-context.js";
import { FakeExtractor, FakeObjectStore } from "./fakes.js";
import { eventIdsToRebuild, handleS3Event } from "./handler.js";
import { rebuildEventContext } from "./rebuild.js";
import type { S3Event } from "aws-lambda";

const EVENT = "evt-1";
const NOW = new Date("2026-09-16T00:00:00.000Z");

function deps(store: FakeObjectStore) {
  return { store, extractor: new FakeExtractor(), now: () => NOW };
}

function s3Event(...keys: string[]): S3Event {
  return {
    Records: keys.map((key) => ({ s3: { object: { key } } })),
  } as unknown as S3Event;
}

describe("parseMaterialKey (ADR 0021)", () => {
  it("資料本体のキーを分解する", () => {
    expect(parseMaterialKey("assets/materials/evt-1/a1/deck.pdf")).toEqual({
      eventId: "evt-1",
      assetId: "a1",
      filename: "deck.pdf",
    });
  });

  it("_context.json は null (これを弾かないと抽出が無限ループする)", () => {
    expect(parseMaterialKey("assets/materials/evt-1/_context.json")).toBeNull();
  });

  it("prefix 外や段数違いは null", () => {
    expect(parseMaterialKey("assets/decks/evt-1/a1/deck.pdf")).toBeNull();
    expect(parseMaterialKey("assets/materials/evt-1/a1/sub/deck.pdf")).toBeNull();
    expect(parseMaterialKey("assets/materials/evt-1/")).toBeNull();
  });
});

describe("buildMaterialsContext (ADR 0021 D-2)", () => {
  it("ファイル名とページ番号を見出しにして連結する", () => {
    const ctx = buildMaterialsContext(
      EVENT,
      [{ assetId: "a1", filename: "deck.pdf", pages: [{ text: "一枚目" }, { text: "二枚目" }] }],
      NOW,
    );
    expect(ctx.version).toBe(1);
    expect(ctx.eventId).toBe(EVENT);
    expect(ctx.updatedAt).toBe(NOW.toISOString());
    expect(ctx.fullText).toBe("## deck.pdf\n[p1] 一枚目\n[p2] 二枚目");
  });

  it("空白を潰す (PDF 抽出はレイアウト由来の空白が多い)", () => {
    expect(normalizeText("  a   b \n\n c  ")).toBe("a b c");
  });

  it("資料 1 件あたりの上限で切り、以降のページは落とす", () => {
    const long = "あ".repeat(MATERIAL_CHAR_LIMIT + 100);
    const ctx = buildMaterialsContext(
      EVENT,
      [{ assetId: "a1", filename: "big.pdf", pages: [{ text: long }, { text: "次のページ" }] }],
      NOW,
    );
    const total = ctx.materials[0]!.pages.reduce((n, p) => n + p.text.length, 0);
    expect(total).toBe(MATERIAL_CHAR_LIMIT);
  });

  it("全体の上限を超える資料は載せない (中途半端に切ると文が壊れるため)", () => {
    const page = "い".repeat(MATERIAL_CHAR_LIMIT);
    const material = (id: string) => ({
      assetId: id,
      filename: `${id}.pdf`,
      pages: [{ text: page }],
    });
    const ctx = buildMaterialsContext(EVENT, [material("a1"), material("a2"), material("a3")], NOW);
    expect(ctx.fullText.length).toBeLessThanOrEqual(MATERIALS_CONTEXT_CHAR_LIMIT);
    expect(ctx.materials.length).toBeLessThan(3);
  });

  it("本文が取れない資料も一覧には残す (画像だけの PDF 等)", () => {
    const ctx = buildMaterialsContext(
      EVENT,
      [{ assetId: "a1", filename: "scan.pdf", pages: [{ text: "" }] }],
      NOW,
    );
    expect(ctx.materials).toHaveLength(1);
    expect(ctx.fullText).toBe("");
  });
});

describe("rebuildEventContext (ADR 0021 D-2)", () => {
  it("資料を読み直して _context.json を書く", async () => {
    const store = new FakeObjectStore();
    store.putText("assets/materials/evt-1/a1/notes.md", "前半\n\n後半");
    await rebuildEventContext(EVENT, deps(store));

    const ctx = store.readJson<MaterialsContext>(materialsContextKey(EVENT));
    expect(ctx?.materials).toHaveLength(1);
    expect(ctx?.fullText).toBe("## notes.md\n[p1] 前半\n[p2] 後半");
  });

  it("_context.json 自身は資料として読み込まない", async () => {
    const store = new FakeObjectStore();
    store.putText("assets/materials/evt-1/a1/notes.md", "本文");
    store.putText(materialsContextKey(EVENT), "{}");
    const d = deps(store);
    await rebuildEventContext(EVENT, d);
    expect(d.extractor.calls).toEqual(["notes.md"]);
  });

  it("対応しない形式は飛ばす", async () => {
    const store = new FakeObjectStore();
    store.putText("assets/materials/evt-1/a1/movie.mp4", "binary");
    store.putText("assets/materials/evt-1/a2/notes.md", "本文");
    await rebuildEventContext(EVENT, deps(store));

    const ctx = store.readJson<MaterialsContext>(materialsContextKey(EVENT));
    expect(ctx?.materials.map((m) => m.filename)).toEqual(["notes.md"]);
  });

  it("1 件の取得失敗で他の資料まで落とさない", async () => {
    const store = new FakeObjectStore();
    store.putText("assets/materials/evt-1/a1/broken.md", "x");
    store.putText("assets/materials/evt-1/a2/ok.md", "無事");
    store.failOnGet.add("assets/materials/evt-1/a1/broken.md");
    await rebuildEventContext(EVENT, deps(store));

    const ctx = store.readJson<MaterialsContext>(materialsContextKey(EVENT));
    expect(ctx?.materials.map((m) => m.filename)).toEqual(["ok.md"]);
  });

  it("資料が無くなったら _context.json を消す (消した資料の用語が効き続けるのを防ぐ)", async () => {
    const store = new FakeObjectStore();
    store.putText(materialsContextKey(EVENT), "{}");
    const result = await rebuildEventContext(EVENT, deps(store));

    expect(result).toBeNull();
    expect(store.removed).toContain(materialsContextKey(EVENT));
  });
});

describe("handleS3Event (ADR 0021 D-2)", () => {
  it("_context.json の PUT だけなら何もしない (無限ループ防止)", async () => {
    const store = new FakeObjectStore();
    store.putText("assets/materials/evt-1/a1/notes.md", "本文");
    const d = deps(store);
    await handleS3Event(s3Event(materialsContextKey(EVENT)), d);
    expect(d.extractor.calls).toEqual([]);
  });

  it("同じイベントの複数レコードは 1 回にまとめる", () => {
    expect(
      eventIdsToRebuild(
        s3Event("assets/materials/evt-1/a1/x.pdf", "assets/materials/evt-1/a2/y.pdf"),
      ),
    ).toEqual(["evt-1"]);
  });

  it("URL エンコードされたキーを戻す (スペースは + で届く)", () => {
    expect(eventIdsToRebuild(s3Event("assets/materials/evt-1/a1/my+deck.pdf"))).toEqual(["evt-1"]);
  });

  it("1 イベントの失敗で他のイベントを諦めない", async () => {
    const store = new FakeObjectStore();
    store.putText("assets/materials/evt-1/a1/notes.md", "本文1");
    store.putText("assets/materials/evt-2/a1/notes.md", "本文2");
    store.failOnGet.add("assets/materials/evt-1/a1/notes.md");

    await handleS3Event(
      s3Event("assets/materials/evt-1/a1/notes.md", "assets/materials/evt-2/a1/notes.md"),
      deps(store),
    );
    expect(store.readJson<MaterialsContext>(materialsContextKey("evt-2"))).toBeDefined();
  });
});
