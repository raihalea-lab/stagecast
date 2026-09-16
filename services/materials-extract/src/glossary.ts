/**
 * 登壇資料から用語集を作り、Amazon Translate の Custom Terminology に載せる
 * (ADR 0021 D-3 の低遅延経路)。
 *
 * Amazon Translate は文脈を渡せないので、資料を効かせる手段はこれだけ。ただし
 * **exact match** で置換されるため、一般語を入れると訳が壊れる。固有名詞・技術用語・
 * 略語に限定し、件数も絞る。
 */
import { createLogger, terminologyName, type LanguageCode } from "@stagecast/shared";

const log = createLogger({ component: "materials-glossary" });

/** 用語集に載せる最大件数 (ADR 0021 D-3)。多いほど過剰適用の危険が増す。 */
export const GLOSSARY_MAX_ENTRIES = 200;

/** 1 語の訳。`target` は言語コードごとの訳語。 */
export interface GlossaryEntry {
  source: string;
  targets: Partial<Record<LanguageCode, string>>;
}

/** 用語集を生成する LLM。実体は Bedrock。 */
export interface GlossaryGenerator {
  generate(
    fullText: string,
    source: LanguageCode,
    targets: LanguageCode[],
  ): Promise<GlossaryEntry[]>;
}

/** Amazon Translate の用語集を出し入れする。 */
export interface TerminologyStore {
  importCsv(name: string, csv: string): Promise<void>;
  remove(name: string): Promise<void>;
}

/** CSV の 1 セルを引用する (用語に `,` や `"` が入りうる)。 */
function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Translate の CSV 形式に整える。**2 列 (source, target)**。
 *
 * 訳語が空の行や、source と訳語が同一の行は落とす (置換しても意味がなく、
 * 件数だけ食うため)。件数の `slice` は安全弁で、ここで切れているなら LLM が
 * プロンプトの「最大 N 件」を無視している。
 */
export function buildTerminologyCsv(
  entries: GlossaryEntry[],
  source: LanguageCode,
  target: LanguageCode,
): string | undefined {
  const usable = entries
    .filter((e) => e.source.trim().length > 0)
    .filter((e) => e.targets[target] && e.targets[target] !== e.source)
    .slice(0, GLOSSARY_MAX_ENTRIES);
  if (usable.length === 0) return undefined;

  const header = [source, target].map(quote).join(",");
  const rows = usable.map((e) => [e.source, e.targets[target] ?? ""].map(quote).join(","));
  return [header, ...rows].join("\n");
}

export interface SyncGlossaryDeps {
  generator: GlossaryGenerator;
  terminology: TerminologyStore;
}

/**
 * 資料から用語集を作り直す。
 *
 * 生成や登録に失敗しても例外を投げない。用語集は翻訳の補助であり、これで抽出全体を
 * 落とすと `_context.json` (品質重視経路が使う) まで届かなくなる。
 */
export async function syncGlossary(
  eventId: string,
  fullText: string,
  source: LanguageCode,
  targets: LanguageCode[],
  deps: SyncGlossaryDeps,
): Promise<LanguageCode[]> {
  const wanted = targets.filter((t) => t !== source);
  if (!fullText || wanted.length === 0) return [];
  try {
    const entries = await deps.generator.generate(fullText, source, wanted);
    const imported: LanguageCode[] = [];
    for (const target of wanted) {
      const name = terminologyName(eventId, target);
      const csv = buildTerminologyCsv(entries, source, target);
      if (!csv) {
        // その言語の用語が取れなかった。古い用語集が残っていると消した資料の訳語が効き続ける。
        await deps.terminology.remove(name);
        continue;
      }
      await deps.terminology.importCsv(name, csv);
      imported.push(target);
    }
    log.info("glossary imported", { eventId, entries: entries.length, targets: imported });
    return imported;
  } catch (err) {
    log.error("glossary sync failed", { eventId, err });
    return [];
  }
}

/** イベントの用語集をすべて消す (資料が無くなったとき)。 */
export async function removeGlossaries(
  eventId: string,
  targets: LanguageCode[],
  terminology: TerminologyStore,
): Promise<void> {
  for (const target of targets) {
    await terminology.remove(terminologyName(eventId, target)).catch(() => {});
  }
}
