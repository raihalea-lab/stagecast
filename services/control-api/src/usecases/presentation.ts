/**
 * 発表者状態の更新 API (DESIGN.md 5.3, F-4)。
 *
 * 管理者が各登壇者を「発表中(live)/待機(standby)」に切り替える。状態は本番では Valkey に
 * 保持され (DESIGN.md 3.2)、合成処理が即座に反映する。ここでは状態更新の使用例を提供する。
 */
import type { PresentationState, SlideSource, SpeakerVisibility } from "@stagecast/shared";
import type { PresentationRepository } from "../repo/types.js";
import { ValidationError } from "./events.js";

/** 不正な値を保存して合成 (composer) が壊れるのを防ぐ (不正入力は 400)。 */
function validateSpeakerId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError("speakerId is required");
  }
  return value;
}

function validateVisibility(value: unknown): SpeakerVisibility {
  if (value !== "live" && value !== "standby") {
    throw new ValidationError("visibility must be 'live' or 'standby'");
  }
  return value;
}

function validateSlideSource(value: unknown): SlideSource | undefined {
  if (value === undefined || value === null) return undefined;
  if (value !== "screen-share" && value !== "uploaded") {
    throw new ValidationError("slideSource must be 'screen-share' or 'uploaded'");
  }
  return value;
}

function validateSlidePage(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ValidationError("slidePage must be a positive integer");
  }
  return value;
}

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
    const id = validateSpeakerId(speakerId);
    const vis = validateVisibility(visibility);
    return repo.setSpeakerVisibility(eventId, id, vis, now());
  }

  async function setSlide(
    eventId: string,
    slideSource: SlideSource | undefined,
    slidePage?: number,
  ): Promise<PresentationState> {
    const source = validateSlideSource(slideSource);
    const page = validateSlidePage(slidePage);
    return repo.setSlide(eventId, { slideSource: source, slidePage: page });
  }

  return { getState, setSpeakerVisibility, setSlide };
}
