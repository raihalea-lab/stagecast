import { describe, expect, it } from "vitest";
import type { LanguageCode } from "@stagecast/shared";
import { parseGlossaryResponse } from "./aws-glossary.js";
import {
  buildTerminologyCsv,
  GLOSSARY_MAX_ENTRIES,
  syncGlossary,
  terminologyName,
  type GlossaryEntry,
  type GlossaryGenerator,
  type TerminologyStore,
} from "./glossary.js";

const JA = "ja" as LanguageCode;
const EN = "en" as LanguageCode;

class FakeTerminology implements TerminologyStore {
  imported?: { name: string; csv: string };
  removed: string[] = [];
  failImport = false;

  async importCsv(name: string, csv: string): Promise<void> {
    if (this.failImport) throw new Error("boom");
    this.imported = { name, csv };
  }
  async remove(name: string): Promise<void> {
    this.removed.push(name);
  }
}

class FakeGenerator implements GlossaryGenerator {
  constructor(private readonly entries: GlossaryEntry[]) {}
  calls = 0;
  async generate(): Promise<GlossaryEntry[]> {
    this.calls++;
    return this.entries;
  }
}

describe("buildTerminologyCsv (ADR 0021 D-3)", () => {
  it("先頭列が source 言語の CSV を作る", () => {
    const csv = buildTerminologyCsv([{ source: "エージェント", targets: { en: "Agent" } }], JA, [
      EN,
    ]);
    expect(csv).toBe('"ja","en"\n"エージェント","Agent"');
  });

  it("引用符を含む用語をエスケープする", () => {
    const csv = buildTerminologyCsv([{ source: 'a"b', targets: { en: "c,d" } }], JA, [EN])!;
    expect(csv).toContain('"a""b","c,d"');
  });

  it("訳語が原語と同じ行は落とす (置換しても意味がなく件数だけ食う)", () => {
    const csv = buildTerminologyCsv([{ source: "AWS", targets: { en: "AWS" } }], JA, [EN]);
    expect(csv).toBeUndefined();
  });

  it("訳語が空の行は落とす", () => {
    const csv = buildTerminologyCsv([{ source: "用語", targets: {} }], JA, [EN]);
    expect(csv).toBeUndefined();
  });

  it("件数の上限で切る (exact match の過剰適用を抑える)", () => {
    const many = Array.from({ length: GLOSSARY_MAX_ENTRIES + 50 }, (_, i) => ({
      source: `語${i}`,
      targets: { en: `Term${i}` },
    }));
    const csv = buildTerminologyCsv(many, JA, [EN])!;
    // 先頭行はヘッダー。
    expect(csv.split("\n")).toHaveLength(GLOSSARY_MAX_ENTRIES + 1);
  });
});

describe("terminologyName", () => {
  it("イベントごとに名前を分ける", () => {
    expect(terminologyName("326c8d88-e4b6")).toBe("stagecast-326c8d88-e4b6");
  });
});

describe("parseGlossaryResponse (ADR 0021 D-3)", () => {
  it("JSON の前後に説明文が付いていても取り出す", () => {
    const entries = parseGlossaryResponse(
      'はい。\n{"entries":[{"source":"エージェント","targets":{"en":"Agent"}}]}\n以上です。',
    );
    expect(entries).toEqual([{ source: "エージェント", targets: { en: "Agent" } }]);
  });

  it("JSON でなければ空配列 (用語集なしで続行する)", () => {
    expect(parseGlossaryResponse("申し訳ありませんが…")).toEqual([]);
    expect(parseGlossaryResponse("{壊れた")).toEqual([]);
  });

  it("source や targets が不正な要素は落とす", () => {
    const entries = parseGlossaryResponse(
      '{"entries":[{"source":"","targets":{"en":"X"}},{"source":"OK","targets":{"en":"Fine","ja":123}}]}',
    );
    expect(entries).toEqual([{ source: "OK", targets: { en: "Fine" } }]);
  });
});

describe("syncGlossary (ADR 0021 D-3)", () => {
  const deps = (entries: GlossaryEntry[], terminology = new FakeTerminology()) => ({
    generator: new FakeGenerator(entries),
    terminology,
  });

  it("用語集を登録して名前を返す", async () => {
    const terminology = new FakeTerminology();
    const name = await syncGlossary(
      "evt-1",
      "本文",
      JA,
      [EN],
      deps([{ source: "エージェント", targets: { en: "Agent" } }], terminology),
    );
    expect(name).toBe("stagecast-evt-1");
    expect(terminology.imported?.csv).toContain("Agent");
  });

  it("用語が 1 件も取れなければ古い用語集を消す", async () => {
    const terminology = new FakeTerminology();
    const name = await syncGlossary("evt-1", "本文", JA, [EN], deps([], terminology));
    expect(name).toBeUndefined();
    expect(terminology.removed).toEqual(["stagecast-evt-1"]);
  });

  it("登録に失敗しても例外を投げない (抽出全体を落とさない)", async () => {
    const terminology = new FakeTerminology();
    terminology.failImport = true;
    const name = await syncGlossary(
      "evt-1",
      "本文",
      JA,
      [EN],
      deps([{ source: "A", targets: { en: "B" } }], terminology),
    );
    expect(name).toBeUndefined();
  });

  it("target が source だけなら何もしない", async () => {
    const d = deps([{ source: "A", targets: { en: "B" } }]);
    await syncGlossary("evt-1", "本文", JA, [JA], d);
    expect(d.generator.calls).toBe(0);
  });
});
