/**
 * 発表状態の更新 API (DESIGN.md 5.3, F-4, ADR 0022)。
 *
 * 管理者が各登壇者を「発表中(live)/待機(standby)」に切り替える。あわせて
 * **投影状態 (どのデッキの何ページ目か) の正もここが持つ** (ADR 0022 D-1)。
 * 永続化は制御層の DynamoDB (`DynamoPresentationRepository`)。合成処理と登壇者は
 * 入室時にこれを読めば現在の投影が分かる。
 */
import type { DeckRef, PresentationState, SlideSource, SpeakerVisibility } from "@stagecast/shared";
import type { PresentationRepository, SlideUpdate } from "../repo/types.js";
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

/**
 * デッキ参照を検証する (ADR 0022 D-1)。
 *
 * `assetId` / `filename` はそのまま S3 のキーに組み立てられるので、区切り文字を
 * 含むものは弾く。通すと他イベントの資料を指す参照を保存できてしまう。
 */
function validateDeck(value: unknown): DeckRef | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") throw new ValidationError("deck must be an object");
  const d = value as Record<string, unknown>;
  const assetId = d["assetId"];
  const filename = d["filename"];
  const pageCount = d["pageCount"];
  for (const [name, v] of [
    ["assetId", assetId],
    ["filename", filename],
  ] as const) {
    if (typeof v !== "string" || !v.trim()) {
      throw new ValidationError(`deck.${name} is required`);
    }
    if (v.includes("/") || v.includes("\\") || v.includes("..")) {
      throw new ValidationError(`deck.${name} must not contain path separators`);
    }
  }
  if (typeof pageCount !== "number" || !Number.isInteger(pageCount) || pageCount < 1) {
    throw new ValidationError("deck.pageCount must be a positive integer");
  }
  return { assetId: assetId as string, filename: filename as string, pageCount };
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

  /**
   * 投影状態を更新する (ADR 0022 D-1)。
   *
   * `slideSource` を省略すると投影解除。その場合はページもデッキも消える
   * (残すと解除済みの PDF を後から入ったクライアントが読む)。
   */
  async function setSlide(
    eventId: string,
    slideSource: SlideSource | undefined,
    slidePage?: number,
    deck?: unknown,
  ): Promise<PresentationState> {
    const source = validateSlideSource(slideSource);
    const page = validateSlidePage(slidePage);
    const deckRef = validateDeck(deck);
    if (source !== "uploaded" && deckRef) {
      throw new ValidationError("deck is only valid when slideSource is 'uploaded'");
    }
    const update: SlideUpdate = source
      ? { slideSource: source, slidePage: page, deck: deckRef, slideUpdatedAtMs: now() }
      : // 解除。updatedAtMs も消さずに進めておく (競合時に新しい方を採るため)。
        { slideSource: undefined, slidePage: undefined, deck: undefined, slideUpdatedAtMs: now() };
    return repo.setSlide(eventId, update);
  }

  return { getState, setSpeakerVisibility, setSlide };
}
