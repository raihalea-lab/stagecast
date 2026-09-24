import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Badge } from "./badge.js";
import { Chip } from "./chip.js";

afterEach(cleanup);

describe("Badge", () => {
  it("既定は neutral、variant で色が変わる", () => {
    render(
      <>
        <Badge>JST</Badge>
        <Badge variant="brand">カレンダーに公開</Badge>
      </>,
    );
    expect(screen.getByText("JST").className).toContain("bg-surface-2");
    expect(screen.getByText("カレンダーに公開").className).toContain("bg-brand-600");
  });
});

describe("Chip", () => {
  it("selected を aria-pressed で伝え、クリックで onClick が呼ばれる", () => {
    const onClick = vi.fn();
    render(
      <>
        <Chip selected onClick={onClick}>
          すべて
        </Chip>
        <Chip>下書き</Chip>
      </>,
    );
    const all = screen.getByRole("button", { name: "すべて" });
    expect(all.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "下書き" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    fireEvent.click(all);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
