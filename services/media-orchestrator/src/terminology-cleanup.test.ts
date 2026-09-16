import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADR 0021 D-3: 終了したイベントの用語集回収。
 *
 * 外部接続なしで検証する (CLAUDE.md テスト方針) ため、SDK のモジュールごと差し替える。
 */
const sent: unknown[] = [];
let pages: { TerminologyPropertiesList: { Name: string }[]; NextToken?: string }[] = [];

vi.mock("@aws-sdk/client-translate", () => {
  class ListTerminologiesCommand {
    constructor(readonly input: { NextToken?: string }) {}
  }
  class DeleteTerminologyCommand {
    constructor(readonly input: { Name: string }) {}
  }
  class TranslateClient {
    async send(cmd: { input: { Name?: string } }) {
      sent.push(cmd);
      if (cmd instanceof ListTerminologiesCommand) return pages.shift() ?? {};
      return {};
    }
  }
  return { TranslateClient, ListTerminologiesCommand, DeleteTerminologyCommand };
});

const { deleteEventTerminologies } = await import("./reconcile-handler.js");

function deletedNames(): string[] {
  return sent
    .filter((c): c is { input: { Name: string } } => "Name" in (c as { input: object }).input)
    .map((c) => c.input.Name);
}

describe("deleteEventTerminologies (ADR 0021 D-3)", () => {
  beforeEach(() => {
    sent.length = 0;
    pages = [];
  });

  it("そのイベントの用語集だけを消す", async () => {
    pages = [
      {
        TerminologyPropertiesList: [
          { Name: "stagecast-evt-1-en" },
          { Name: "stagecast-evt-1-zh-TW" },
          { Name: "stagecast-evt-2-en" },
          { Name: "someone-elses-glossary" },
        ],
      },
    ];
    expect(await deleteEventTerminologies("evt-1")).toBe(2);
    expect(deletedNames()).toEqual(["stagecast-evt-1-en", "stagecast-evt-1-zh-TW"]);
  });

  it("イベント ID が前方一致する別イベントを巻き込まない", async () => {
    // `stagecast-evt-1-` で始まるかを見るので、`evt-12` は別イベントとして残る。
    pages = [
      {
        TerminologyPropertiesList: [
          { Name: "stagecast-evt-1-en" },
          { Name: "stagecast-evt-12-en" },
        ],
      },
    ];
    expect(await deleteEventTerminologies("evt-1")).toBe(1);
    expect(deletedNames()).toEqual(["stagecast-evt-1-en"]);
  });

  it("ページングを最後までたどる", async () => {
    pages = [
      { TerminologyPropertiesList: [{ Name: "stagecast-evt-1-en" }], NextToken: "n1" },
      { TerminologyPropertiesList: [{ Name: "stagecast-evt-1-ko" }] },
    ];
    expect(await deleteEventTerminologies("evt-1")).toBe(2);
    expect(deletedNames()).toEqual(["stagecast-evt-1-en", "stagecast-evt-1-ko"]);
  });

  it("消すものが無ければ何も呼ばない", async () => {
    pages = [{ TerminologyPropertiesList: [{ Name: "stagecast-evt-9-en" }] }];
    expect(await deleteEventTerminologies("evt-1")).toBe(0);
    expect(deletedNames()).toEqual([]);
  });
});
