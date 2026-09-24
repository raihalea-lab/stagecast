// @vitest-environment jsdom
/**
 * App のロール別描画テスト (STAGE_UX_PLAN Tier 0)。
 * 外部接続なし: StageClient / RoomConnector / MediaDevices は全部フェイク。
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { encodeRoomMetadata, LAYOUT_LABELS } from "@stagecast/shared";
import { TooltipProvider } from "@stagecast/ui";
import type { ComponentProps } from "react";
import { App } from "./App.js";
import { FakeStageClient } from "./api/fake-stage-client.js";
import type { JoinResponse } from "./api/stage-client.js";
import { FakeRoomConnector } from "./lib/room.js";
import { FakeMediaDevicesProvider } from "./lib/devices.js";

beforeAll(() => {
  // react-resizable-panels が要る。jsdom には無い。
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);

const join = (role: "speaker" | "moderator"): JoinResponse => ({
  ok: true,
  eventId: "evt-1",
  role,
  room: "evt-1",
  identity: `${role}-1`,
  livekitUrl: "wss://sfu.test",
  livekitToken: "jwt.token.here",
});

/** main.tsx と同じく TooltipProvider で包む (LayoutPicker の Tooltip が要る)。 */
function renderApp(props: Omit<ComponentProps<typeof App>, "devices">) {
  return render(
    <TooltipProvider>
      <App {...props} devices={new FakeMediaDevicesProvider([])} />
    </TooltipProvider>,
  );
}

async function enterAs(
  role: "speaker" | "moderator",
  room = new FakeRoomConnector(),
  config?: ComponentProps<typeof App>["config"],
) {
  renderApp({
    client: new FakeStageClient(join(role)),
    room,
    search: "?token=invite-token",
    config,
  });
  fireEvent.click(await screen.findByRole("button", { name: "入室する" }));
  await screen.findByText("evt-1");
  return room;
}

/** ADR 0014 D-4 の admin 直接接続 URL (inviteToken は ADR 0025 D-3)。 */
const ADMIN_SEARCH =
  "?token=lk.jwt&url=wss%3A%2F%2Fsfu.test&eventId=evt-1&inviteToken=invite-token";

describe("App (Tier 0)", () => {
  it("U-2: モデレーターも Egress を開始できる", async () => {
    await enterAs("moderator");
    expect(await screen.findByRole("button", { name: /Egress 開始/ })).toBeTruthy();
  });

  it("U-3: ON AIR は egressActive のときだけ出る", async () => {
    const room = new FakeRoomConnector();
    room.roomMetadata = encodeRoomMetadata({ egressActive: false });
    // composerTemplateUrl があると PreviewWindow (登壇者が見る ON AIR の本体) も描画される。
    await enterAs("speaker", room, {
      controlApiUrl: "https://api.test",
      composerTemplateUrl: "https://composer.test",
    });
    // ヘッダ pill と PreviewWindow の 2 箇所とも、送出前は PREVIEW。
    expect(screen.getAllByText("PREVIEW")).toHaveLength(2);
    expect(screen.queryByText("ON AIR")).toBeNull();

    act(() => room.emitRoomMetadata(encodeRoomMetadata({ egressActive: true })));
    expect(await screen.findAllByText("ON AIR")).toHaveLength(2);
    expect(screen.queryByText("PREVIEW")).toBeNull();
  });

  it("U-4: admin の再試行でも room metadata を反映する", async () => {
    class FlakyRoom extends FakeRoomConnector {
      failures = 1;
      override async connect(url: string, token: string): Promise<void> {
        if (this.failures-- > 0) throw new Error("first connect fails");
        return super.connect(url, token);
      }
    }
    const room = new FlakyRoom();
    renderApp({ client: new FakeStageClient(join("moderator")), room, search: ADMIN_SEARCH });
    const retry = await screen.findByRole("button", { name: "再試行" });
    room.roomMetadata = encodeRoomMetadata({ layout: "spotlight" });
    fireEvent.click(retry);

    const radio = await screen.findByRole("radio", { name: LAYOUT_LABELS.spotlight });
    expect(radio.getAttribute("aria-checked")).toBe("true");
  });

  it("U-1a: admin ビューに『配信終了』は無く、管理画面への案内がある", async () => {
    renderApp({
      client: new FakeStageClient(join("moderator")),
      room: new FakeRoomConnector(),
      search: ADMIN_SEARCH,
    });
    await screen.findByRole("radiogroup", { name: "配信レイアウト" });
    expect(screen.queryByRole("button", { name: "配信終了" })).toBeNull();
    expect(screen.getByText(/イベントの終了は管理画面から/)).toBeTruthy();
  });
});
