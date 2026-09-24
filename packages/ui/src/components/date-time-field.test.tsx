import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DateTimeField, minuteOptions } from "./date-time-field.js";

afterEach(cleanup);

describe("minuteOptions", () => {
  it("刻みに合う分だけを並べる", () => {
    expect(minuteOptions(10)).toEqual(["00", "10", "20", "30", "40", "50"]);
    expect(minuteOptions(15)).toEqual(["00", "15", "30", "45"]);
  });
});

describe("DateTimeField", () => {
  it("datetime-local 形式の値を日付・時・分に分けて表示する", () => {
    render(<DateTimeField id="starts" value="2026-07-01T09:10" onChange={() => {}} />);
    expect((document.getElementById("starts") as HTMLInputElement).value).toBe("2026-07-01");
    expect(screen.getByRole("combobox", { name: "時" }).textContent).toContain("09");
    expect(screen.getByRole("combobox", { name: "分" }).textContent).toContain("10");
  });

  it("日付を変えると時刻を保ったまま datetime-local 形式で返す", () => {
    const onChange = vi.fn();
    render(<DateTimeField id="starts" value="2026-07-01T09:10" onChange={onChange} />);
    fireEvent.change(document.getElementById("starts")!, { target: { value: "2026-07-15" } });
    expect(onChange).toHaveBeenLastCalledWith("2026-07-15T09:10");
  });

  it("日付だけで時刻が未選択なら空を返す (必須チェックに任せる)", () => {
    const onChange = vi.fn();
    render(<DateTimeField id="starts" value="" onChange={onChange} />);
    fireEvent.change(document.getElementById("starts")!, { target: { value: "2026-07-15" } });
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("刻みに合わない分は選択肢に無いので分が空で出る", () => {
    render(<DateTimeField id="starts" value="2026-07-01T09:05" onChange={() => {}} />);
    expect(screen.getByRole("combobox", { name: "分" }).textContent).not.toContain("05");
  });
});
