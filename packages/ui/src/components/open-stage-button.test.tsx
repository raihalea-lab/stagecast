/**
 * OpenStageButton の失敗経路。 async onClick の例外は unhandledrejection に消えて
 * 画面に何も出ないので、 onError に届くことだけは確かめておく。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { OpenStageButton } from "./open-stage-button.js";

describe("OpenStageButton", () => {
  // このパッケージは globals 無しで vitest を回すので auto cleanup が効かない。
  afterEach(cleanup);

  it("stageUrl が URL として壊れていたら onError に渡す", async () => {
    const onError = vi.fn();
    const { getByRole } = render(
      <OpenStageButton
        eventId="evt-001"
        // Lambda が旧版のままだと stageUrl が来ない (PR #258 のデプロイ順序事故)。
        fetcher={async () => ({ token: "t", livekitUrl: "wss://x", expiresAt: 0 }) as never}
        onError={onError}
      />,
    );
    fireEvent.click(getByRole("button"));
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
  });

  it('previewToken が無ければ URL に載せない (旧 Lambda で "undefined" を渡さない)', async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { getByRole } = render(
      <OpenStageButton
        eventId="evt-001"
        fetcher={async () =>
          ({
            token: "lk-token",
            livekitUrl: "wss://x",
            expiresAt: 0,
            stageUrl: "https://stage.example.com",
          }) as never
        }
      />,
    );
    fireEvent.click(getByRole("button"));
    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(String(open.mock.calls[0]?.[0])).not.toContain("previewToken");
    open.mockRestore();
  });

  it("fetcher が成功したら stageUrl に token を載せて開く", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { getByRole } = render(
      <OpenStageButton
        eventId="evt-001"
        fetcher={async () => ({
          token: "lk-token",
          livekitUrl: "wss://x",
          expiresAt: 0,
          stageUrl: "https://stage.example.com",
          previewToken: "pv-token",
        })}
      />,
    );
    fireEvent.click(getByRole("button"));
    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(open.mock.calls[0]?.[0]).toBe(
      "https://stage.example.com/?token=lk-token&url=wss%3A%2F%2Fx&eventId=evt-001&previewToken=pv-token",
    );
    open.mockRestore();
  });
});
