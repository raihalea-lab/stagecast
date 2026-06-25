/**
 * DynamoDB 単一テーブル設計のマッピング (DESIGN.md 3.1, ADR D-4)。
 *
 * CDK の MetadataTable (pk/sk + GSI1) に対応する。ドメインオブジェクトと DynamoDB
 * アイテムの相互変換を純粋関数として切り出し、SDK 呼び出しと独立にテストする。
 *
 * キー設計:
 *  - イベント:      pk=`EVENT#{id}`,   sk=`META`         GSI1: gsi1pk=`EVENT`, gsi1sk=`{startsAt}#{id}`
 *  - 発表状態:      pk=`EVENT#{id}`,   sk=`PRESENTATION`
 *  - 招待トークン:  pk=`INVITE#{jti}`, sk=`META`         GSI1: gsi1pk=`INVITE#{eventId}`, gsi1sk=`{jti}`
 */
import type { EventDefinition, EventRequest, PresentationState } from "@stagecast/shared";
import type { InviteTokenRecord } from "./types.js";

export type Item = Record<string, unknown>;

export const eventPk = (id: string): string => `EVENT#${id}`;
export const invitePk = (jti: string): string => `INVITE#${jti}`;
export const eventRequestPk = (id: string): string => `EVENT_REQUEST#${id}`;

// --- イベント ---
export function eventToItem(event: EventDefinition): Item {
  return {
    pk: eventPk(event.id),
    sk: "META",
    type: "event",
    gsi1pk: "EVENT",
    gsi1sk: `${event.startsAt}#${event.id}`,
    // gsi-live (reconcile が live/warmup イベントを引く) のキー属性。eventId はソートキー、
    // liveStatus はパーティションキー。live または warmup のときだけ liveStatus を立て、
    // それ以外は undefined にして DocClient の removeUndefinedValues で消す → sparse index。
    // ADR 0015 Phase 4: warmup 状態でもインフラ起動が必要なので liveStatus を立てる。
    eventId: event.id,
    liveStatus: event.status === "live" || event.status === "warmup" ? "live" : undefined,
    ...event,
  };
}

export function itemToEvent(item: Item): EventDefinition {
  return {
    id: item.id as string,
    title: item.title as string,
    startsAt: item.startsAt as string,
    endsAt: item.endsAt as string | undefined,
    status: item.status as EventDefinition["status"],
    qrAsset: item.qrAsset as EventDefinition["qrAsset"],
    brandingAssets: item.brandingAssets as EventDefinition["brandingAssets"],
    slideAssets: item.slideAssets as EventDefinition["slideAssets"],
    caption: item.caption as EventDefinition["caption"],
    youtube: item.youtube as EventDefinition["youtube"],
    // ADR 0008 D-1: reconcile が書き戻す per-event LiveKit URL 等。
    media: item.media as EventDefinition["media"],
    createdAtMs: item.createdAtMs as number,
    updatedAtMs: item.updatedAtMs as number,
  };
}

// --- 招待トークン記録 ---
export function inviteToItem(record: InviteTokenRecord): Item {
  return {
    pk: invitePk(record.jti),
    sk: "META",
    type: "invite",
    gsi1pk: `INVITE#${record.eventId}`,
    gsi1sk: record.jti,
    ...record,
  };
}

export function itemToInvite(item: Item): InviteTokenRecord {
  return {
    jti: item.jti as string,
    eventId: item.eventId as string,
    role: item.role as InviteTokenRecord["role"],
    currentVersion: item.currentVersion as number,
    revoked: item.revoked as boolean,
  };
}

// --- イベントリクエスト ---
export function eventRequestToItem(request: EventRequest): Item {
  return {
    pk: eventRequestPk(request.id),
    sk: "META",
    type: "event_request",
    gsi1pk: "EVENT_REQUEST",
    gsi1sk: `${request.createdAtMs}#${request.id}`,
    ...request,
  };
}

export function itemToEventRequest(item: Item): EventRequest {
  return {
    id: item.id as string,
    requesterName: item.requesterName as string,
    contactInfo: (item.contactInfo ?? item.requesterEmail) as string | undefined,
    title: item.title as string,
    startsAt: item.startsAt as string,
    endsAt: item.endsAt as string,
    description: item.description as string | undefined,
    status: item.status as EventRequest["status"],
    approvedEventId: item.approvedEventId as string | undefined,
    rejectionReason: item.rejectionReason as string | undefined,
    createdAtMs: item.createdAtMs as number,
    updatedAtMs: item.updatedAtMs as number,
  };
}

// --- 発表状態 ---
export function presentationToItem(state: PresentationState): Item {
  return {
    pk: eventPk(state.eventId),
    sk: "PRESENTATION",
    type: "presentation",
    ...state,
  };
}

export function itemToPresentation(item: Item): PresentationState {
  return {
    eventId: item.eventId as string,
    speakers: (item.speakers as PresentationState["speakers"]) ?? [],
    slideSource: item.slideSource as PresentationState["slideSource"],
    slidePage: item.slidePage as number | undefined,
  };
}
