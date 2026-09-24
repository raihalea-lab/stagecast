import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Sheet, SheetContent, SheetTitle } from "./sheet.js";

afterEach(cleanup);

describe("SheetContent", () => {
  // Sheet は fixed + h-full で画面の高さに固定され、Radix が背面の body スクロールを止める。
  // 中身が画面より長いとき (admin-web の新規イベントフォーム) に自分でスクロールできないと詰む。
  // ponytail: jsdom はレイアウトを持たないので、スクロール可能性は class の有無で固定する。
  it("中身が画面より長いときに自分でスクロールできる", () => {
    render(
      <Sheet open>
        <SheetContent side="right">
          <SheetTitle>新規イベント</SheetTitle>
        </SheetContent>
      </Sheet>,
    );
    expect(screen.getByRole("dialog").className).toContain("overflow-y-auto");
  });
});
