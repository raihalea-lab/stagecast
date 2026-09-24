import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Alert } from "./alert.js";

afterEach(cleanup);

describe("Alert", () => {
  it("既定は role=alert のエラー表示", () => {
    render(<Alert>保存に失敗しました</Alert>);
    const el = screen.getByRole("alert");
    expect(el.textContent).toContain("保存に失敗しました");
    expect(el.className).toContain("border-error/40");
  });

  it("warning は警告色", () => {
    render(<Alert variant="warning">ミュートされました</Alert>);
    expect(screen.getByRole("alert").className).toContain("border-warning/40");
  });

  it("onDismiss を渡すと閉じるボタンが出て呼ばれる", () => {
    const onDismiss = vi.fn();
    render(<Alert onDismiss={onDismiss}>x</Alert>);
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("onDismiss が無ければ閉じるボタンは出ない", () => {
    render(<Alert>x</Alert>);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
