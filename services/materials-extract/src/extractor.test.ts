/**
 * 抽出器のテスト。PDF / PPTX は「実ファイルをその場で組み立てて」検証する
 * (外部接続もフィクスチャも持たずに完結させる, CLAUDE.md テスト方針)。
 */
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createExtractor } from "./extractor.js";
import { extractPdfPages } from "./extract-pdf.js";
import { extractPptxPages } from "./extract-pptx.js";
import { readZipEntries } from "./zip.js";

/** 最小の ZIP を組み立てる (stored / deflate を選べる)。 */
function makeZip(files: { name: string; body: string }[], compress: boolean): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const raw = Buffer.from(f.body, "utf8");
    const data = compress ? deflateRawSync(raw) : raw;
    const method = compress ? 8 : 0;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x0403_4b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x0201_4b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x0605_4b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return new Uint8Array(Buffer.concat([...locals, centralBuf, eocd]));
}

function slideXml(...texts: string[]): string {
  const body = texts.map((t) => `<a:r><a:t>${t}</a:t></a:r>`).join("");
  return `<?xml version="1.0"?><p:sld><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
}

describe("zip リーダー (ADR 0021 D-2)", () => {
  it("deflate と stored の両方を読める", () => {
    for (const compress of [true, false]) {
      const zip = makeZip([{ name: "a.txt", body: "こんにちは" }], compress);
      const entries = readZipEntries(zip);
      expect(entries).toHaveLength(1);
      expect(new TextDecoder().decode(entries[0]!.read())).toBe("こんにちは");
    }
  });

  it("ZIP でないデータは空配列 (壊れた資料で例外にしない)", () => {
    expect(readZipEntries(new TextEncoder().encode("not a zip"))).toEqual([]);
  });
});

describe("PPTX 抽出 (ADR 0021 D-2)", () => {
  it("スライド番号順に並べ直す (ZIP の格納順はスライド順とは限らない)", () => {
    const zip = makeZip(
      [
        { name: "ppt/slides/slide10.xml", body: slideXml("十枚目") },
        { name: "ppt/slides/slide2.xml", body: slideXml("二枚目") },
        { name: "ppt/slides/slide1.xml", body: slideXml("一枚目") },
      ],
      true,
    );
    expect(extractPptxPages(zip).map((p) => p.text)).toEqual(["一枚目", "二枚目", "十枚目"]);
  });

  it("話者ノートを同じスライドに取り込む (投影しない資料こそ文脈として効く, D-1)", () => {
    const zip = makeZip(
      [
        { name: "ppt/notesSlides/notesSlide1.xml", body: slideXml("補足説明") },
        { name: "ppt/slides/slide1.xml", body: slideXml("本文") },
      ],
      true,
    );
    expect(extractPptxPages(zip).map((p) => p.text)).toEqual(["本文\n(ノート) 補足説明"]);
  });

  it("スライドもノートも無いエントリは無視する", () => {
    const zip = makeZip(
      [
        { name: "ppt/media/image1.png", body: "binary" },
        { name: "ppt/slides/slide1.xml", body: slideXml("本文") },
      ],
      true,
    );
    expect(extractPptxPages(zip).map((p) => p.text)).toEqual(["本文"]);
  });

  it("ノートだけあってスライドが無い番号は出力しない", () => {
    const zip = makeZip(
      [
        { name: "ppt/slides/slide1.xml", body: slideXml("一枚目") },
        { name: "ppt/notesSlides/notesSlide9.xml", body: slideXml("迷子のノート") },
      ],
      true,
    );
    expect(extractPptxPages(zip)).toHaveLength(1);
  });

  it("XML の実体参照を戻す", () => {
    const zip = makeZip(
      [{ name: "ppt/slides/slide1.xml", body: slideXml("A &amp; B &lt;tag&gt;") }],
      true,
    );
    expect(extractPptxPages(zip)[0]?.text).toBe("A & B <tag>");
  });
});

/**
 * 最小の PDF を組み立てる。標準 14 フォント (Helvetica) + `Tj` だけなので ASCII しか
 * 書けないが、`extractPdfPages` が bundle 前後どちらでも動くことの検証には足りる
 * (日本語の確認は実 PDF を使ったスパイク: docs/spikes/pdf-text-extract.mjs)。
 */
function makePdf(pageTexts: string[]): Uint8Array {
  const objects: string[] = [];
  const pageIds = pageTexts.map((_, i) => 4 + i * 2);

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageTexts.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pageTexts.forEach((text, i) => {
    const pageId = pageIds[i]!;
    const streamId = pageId + 1;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> ` +
      `/MediaBox [0 0 200 200] /Contents ${streamId} 0 R >>`;
    const stream = `BT /F1 12 Tf 10 100 Td (${text}) Tj ET`;
    objects[streamId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

describe("PDF 抽出 (ADR 0021 D-2)", () => {
  it("ページごとにテキストを取り出す", async () => {
    const pages = await extractPdfPages(makePdf(["Hello", "World"]));
    expect(pages.map((p) => p.text)).toEqual(["Hello", "World"]);
  });

  it("壊れた PDF は例外を投げる (呼び出し側がその資料だけ諦められるように)", async () => {
    await expect(extractPdfPages(new TextEncoder().encode("not a pdf"))).rejects.toThrow();
  });

  it("createExtractor 経由でも同じ結果 (worker の差し込みが効いている)", async () => {
    const pages = await createExtractor().extract("deck.pdf", makePdf(["Slide one"]));
    expect(pages?.map((p) => p.text)).toEqual(["Slide one"]);
  });
});

describe("createExtractor (ADR 0021 D-2)", () => {
  const extractor = createExtractor();

  it("md / txt はそのまま 1 ページ", async () => {
    const body = new TextEncoder().encode("# 見出し\n本文");
    expect(await extractor.extract("notes.md", body)).toEqual([{ text: "# 見出し\n本文" }]);
    expect(await extractor.extract("script.txt", body)).toHaveLength(1);
  });

  it("対応しない拡張子は null (エラーにしない)", async () => {
    expect(await extractor.extract("movie.mp4", new Uint8Array())).toBeNull();
    expect(await extractor.extract("noext", new Uint8Array())).toBeNull();
  });

  it("拡張子は大文字でも判定する", async () => {
    expect(await extractor.extract("NOTES.MD", new TextEncoder().encode("x"))).toHaveLength(1);
  });
});
