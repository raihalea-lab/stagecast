/**
 * 制御 API の永続化インターフェース。
 *
 * 実体は DynamoDB (DESIGN.md 3.1) だが、テストとローカルでは外部接続なしに動かせるよう
 * インメモリ実装に差し替える (PROMPT 共通ルール「モック/フェイク実装」)。
 */
import type {
  AssetMetadata,
  EventDefinition,
  EventRequest,
  InvitedRole,
  Preset,
  PresentationState,
  SpeakerVisibility,
} from "@stagecast/shared";

export interface EventRepository {
  put(event: EventDefinition): Promise<void>;
  get(eventId: string): Promise<EventDefinition | undefined>;
  list(): Promise<EventDefinition[]>;
  delete(eventId: string): Promise<void>;
}

/** 招待トークンの失効・再発行を管理する記録 (jti 単位)。 */
export interface InviteTokenRecord {
  jti: string;
  eventId: string;
  /** 付与ロール (再発行時に引き継ぐ)。 */
  role: InvitedRole;
  /** 現在有効なバージョン。再発行で +1。古い version のトークンは無効。 */
  currentVersion: number;
  /** 失効済みフラグ。 */
  revoked: boolean;
  /**
   * 発行時刻 (UNIX 秒)。 署名の入力を固定して、取得のたびに同じ URL を返すために持つ (ADR 0029)。
   * 旧レコードには無い。 無いものは「1 本に絞る」対象から外し、新しく作り直す。
   */
  issuedAtSec?: number;
}

export interface InviteTokenRepository {
  put(record: InviteTokenRecord): Promise<void>;
  /**
   * 同じ jti が無ければ保存し、あれば既存を返す (条件付き put)。
   * get-or-create を同時に 2 回走らせても片方の put が他方の再発行を巻き戻さないための口。
   */
  putIfAbsent(record: InviteTokenRecord): Promise<InviteTokenRecord>;
  get(jti: string): Promise<InviteTokenRecord | undefined>;
  listByEvent(eventId: string): Promise<InviteTokenRecord[]>;
}

export interface EventRequestRepository {
  put(request: EventRequest): Promise<void>;
  get(id: string): Promise<EventRequest | undefined>;
  list(): Promise<EventRequest[]>;
  delete(id: string): Promise<void>;
}

/**
 * 投影状態の更新分 (ADR 0022 D-1)。
 * `deck` は `slideSource === "uploaded"` のときだけ意味を持つ。解除時は全部 undefined。
 */
export type SlideUpdate = Pick<
  PresentationState,
  "slideSource" | "slidePage" | "deck" | "slideUpdatedAtMs"
>;

/**
 * 投影状態を状態オブジェクトに反映する。
 *
 * `undefined` のフィールドは**消す**。投影解除 (`setSlide(eventId, undefined)`) で
 * デッキが残ると、解除したはずの PDF を後から入ったクライアントが読んでしまう。
 *
 * 古い更新は捨てる (ADR 0022 D-2)。モデレーターと登壇者が同時にめくると書き込みが
 * 前後しうるので、最後に書いた方ではなく**新しい方**を残す。
 * 戻り値は反映したかどうか。
 */
export function applySlide(state: PresentationState, slide: SlideUpdate): boolean {
  const prev = state.slideUpdatedAtMs;
  const next = slide.slideUpdatedAtMs;
  if (prev !== undefined && next !== undefined && next < prev) return false;
  state.slideSource = slide.slideSource;
  state.slidePage = slide.slidePage;
  state.deck = slide.deck;
  state.slideUpdatedAtMs = next;
  return true;
}

/** レイアウトの更新分 (ADR 0025 D-1)。 */
export type LayoutUpdate = Pick<
  PresentationState,
  "layout" | "focusIdentity" | "layoutUpdatedAtMs"
>;

/**
 * レイアウトを状態オブジェクトに反映する (ADR 0025 D-1)。
 *
 * `applySlide` と同じく、古い更新は捨てる。管理ウィンドウが複数あると書き込みが前後しうる。
 * 戻り値は反映したかどうか。
 */
export function applyLayout(state: PresentationState, update: LayoutUpdate): boolean {
  const prev = state.layoutUpdatedAtMs;
  const next = update.layoutUpdatedAtMs;
  if (prev !== undefined && next !== undefined && next < prev) return false;
  state.layout = update.layout;
  state.focusIdentity = update.focusIdentity;
  state.layoutUpdatedAtMs = next;
  return true;
}

export interface PresentationRepository {
  get(eventId: string): Promise<PresentationState | undefined>;
  setSpeakerVisibility(
    eventId: string,
    speakerId: string,
    visibility: SpeakerVisibility,
    nowMs: number,
  ): Promise<PresentationState>;
  setSlide(eventId: string, slide: SlideUpdate): Promise<PresentationState>;
  setLayout(eventId: string, update: LayoutUpdate): Promise<PresentationState>;
}

export interface AssetMetadataRepository {
  put(asset: AssetMetadata): Promise<void>;
  get(assetId: string): Promise<AssetMetadata | undefined>;
  list(): Promise<AssetMetadata[]>;
  delete(assetId: string): Promise<void>;
  updateTags(assetId: string, tags: string[]): Promise<AssetMetadata>;
  updateDescription(assetId: string, description: string): Promise<AssetMetadata>;
}

export interface PresetRepository {
  put(preset: Preset): Promise<void>;
  get(eventId: string, presetId: string): Promise<Preset | undefined>;
  listByEvent(eventId: string): Promise<Preset[]>;
  delete(eventId: string, presetId: string): Promise<void>;
}
