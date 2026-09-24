import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FormField } from "./form-field.js";
import { Input } from "../primitives/input.js";

afterEach(cleanup);

describe("FormField", () => {
  it("label は htmlFor で入力に結び付き、required で必須マークが付く", () => {
    render(
      <FormField id="title" label="タイトル" required>
        <Input id="title" />
      </FormField>,
    );
    const input = screen.getByLabelText(/タイトル/);
    expect(input.id).toBe("title");
    expect(screen.getByText("*")).toBeTruthy();
  });

  it("hint は補足として出て、error があれば error に置き換わり入力と結び付く", () => {
    const { rerender } = render(
      <FormField id="ends" label="終了日時" hint="未入力なら開始 + 2 時間">
        <Input id="ends" />
      </FormField>,
    );
    expect(screen.getByText("未入力なら開始 + 2 時間")).toBeTruthy();

    rerender(
      <FormField id="ends" label="終了日時" hint="未入力なら開始 + 2 時間" error="開始より前です">
        <Input id="ends" />
      </FormField>,
    );
    expect(screen.queryByText("未入力なら開始 + 2 時間")).toBeNull();
    const err = screen.getByText("開始より前です");
    expect(err.id).toBe("ends-error");
    expect(screen.getByLabelText(/終了日時/).getAttribute("aria-describedby")).toBe("ends-error");
    expect(screen.getByLabelText(/終了日時/).getAttribute("aria-invalid")).toBe("true");
  });
});
