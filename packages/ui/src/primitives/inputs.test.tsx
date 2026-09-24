import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Checkbox } from "./checkbox.js";
import { Switch } from "./switch.js";
import { Textarea } from "./textarea.js";

afterEach(cleanup);

describe("Checkbox", () => {
  it("ネイティブの checkbox で、変更が onChange に届く", () => {
    const onChange = vi.fn();
    render(<Checkbox aria-label="ja" checked={false} onChange={onChange} />);
    const el = screen.getByRole("checkbox", { name: "ja" });
    fireEvent.click(el);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("Switch", () => {
  it("role=switch で、checked を aria-checked として読める", () => {
    render(<Switch aria-label="字幕を出す" checked onChange={() => {}} />);
    const el = screen.getByRole("switch", { name: "字幕を出す" });
    expect(el.getAttribute("aria-checked")).toBe("true");
  });
});

describe("Textarea", () => {
  it("textarea を描画し、rows を通す", () => {
    render(<Textarea aria-label="説明" rows={3} />);
    expect(screen.getByRole("textbox", { name: "説明" }).getAttribute("rows")).toBe("3");
  });
});
