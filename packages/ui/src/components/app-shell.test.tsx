/**
 * Sidebar リサイズの回帰チェック。幅の clamp と localStorage への保存だけを見る
 * (ドラッグは jsdom に PointerCapture が無いので、同じ経路を通るキーボード操作で代用)。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppShell } from "./app-shell.js";

const KEY = "stagecast:sidebar-width";
const widthOf = (handle: HTMLElement) => handle.getAttribute("aria-valuenow");

function renderShell(): HTMLElement {
  render(
    <AppShell sidebar={<nav>side</nav>} topBar={<div>top</div>}>
      <p>main</p>
    </AppShell>,
  );
  return screen.getByRole("separator");
}

describe("AppShell sidebar resize", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it("右キーで広がり、幅が保存される", () => {
    const handle = renderShell();
    expect(widthOf(handle)).toBe("260");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(widthOf(handle)).toBe("276");
    expect(localStorage.getItem(KEY)).toBe("276");
  });

  it("保存済みの幅で復元する", () => {
    localStorage.setItem(KEY, "420");
    expect(widthOf(renderShell())).toBe("420");
  });

  it("上下限を超えない", () => {
    localStorage.setItem(KEY, "9999");
    const handle = renderShell();
    expect(widthOf(handle)).toBe("520");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(widthOf(handle)).toBe("520");
  });
});
