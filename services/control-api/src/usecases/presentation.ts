/**
 * 発表者状態の更新 API (DESIGN.md 5.3, F-4)。
 *
 * 管理者が各登壇者を「発表中(live)/待機(standby)」に切り替える。状態は本番では Valkey に
 * 保持され (DESIGN.md 3.2)、合成処理が即座に反映する。ここでは状態更新の使用例を提供する。
 */
import type { PresentationState, SlideSource, SpeakerVisibility } from "@stagecast/shared";
import type { PresentationRepository } from "../repo/types.js";

export function createPresentationService(deps: {
  repo: PresentationRepository;
  now: () => number;
}) {
  const { repo, now } = deps;

  async function getState(eventId: string): Promise<PresentationState> {
    return (await repo.get(eventId)) ?? { eventId, speakers: [] };
  }

  async function setSpeakerVisibility(
    eventId: string,
    speakerId: string,
    visibility: SpeakerVisibility,
  ): Promise<PresentationState> {
    return repo.setSpeakerVisibility(eventId, speakerId, visibility, now());
  }

  async function setSlide(
    eventId: string,
    slideSource: SlideSource | undefined,
    slidePage?: number,
  ): Promise<PresentationState> {
    return repo.setSlide(eventId, { slideSource, slidePage });
  }

  return { getState, setSpeakerVisibility, setSlide };
}
