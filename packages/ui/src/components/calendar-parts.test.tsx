import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CalendarEventPopover, CalendarLegend } from "./calendar-parts.js";

afterEach(cleanup);

describe("CalendarLegend", () => {
  it("5 種の凡例を出し、右側に children を置ける", () => {
    render(
      <CalendarLegend>
        <span>JST</span>
      </CalendarLegend>,
    );
    for (const label of ["下書き", "予定", "配信中", "終了", "リクエスト"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("JST")).toBeTruthy();
  });
});

describe("CalendarEventPopover", () => {
  it("タイトルと時間を出し、閉じると onClose、action があればボタンが出る", () => {
    const onClose = vi.fn();
    const onAction = vi.fn();
    render(
      <CalendarEventPopover
        title="Tech Conf"
        startStr="7/1 09:00"
        endStr="7/1 11:00"
        top={10}
        left={20}
        onClose={onClose}
        action={{ label: "詳細を見る", onClick: onAction }}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Tech Conf" })).toBeTruthy();
    expect(screen.getByText(/7\/1 09:00/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "詳細を見る" }));
    expect(onAction).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("action が無ければボタンは閉じるだけ", () => {
    render(
      <CalendarEventPopover
        title="x"
        startStr="a"
        endStr="b"
        top={0}
        left={0}
        onClose={() => {}}
      />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});
