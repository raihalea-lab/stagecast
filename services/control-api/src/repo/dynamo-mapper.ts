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
import type { EventDefinition, PresentationState } from '@stagecast/shared';
import type { InviteTokenRecord } from './types.js';

export type Item = Record<string, unknown>;

export const eventPk = (id: string): string => `EVENT#${id}`;
export const invitePk = (jti: string): string => `INVITE#${jti}`;

// --- イベント ---
export function eventToItem(event: EventDefinition): Item {
  return {
    pk: eventPk(event.id),
    sk: 'META',
    type: 'event',
    gsi1pk: 'EVENT',
    gsi1sk: `${event.startsAt}#${event.id}`,
    ...event,
  };
}

export function itemToEvent(item: Item): EventDefinition {
  return {
    id: item.id as string,
    title: item.title as string,
    startsAt: item.startsAt as string,
    endsAt: item.endsAt as string | undefined,
    status: item.status as EventDefinition['status'],
    qrAsset: item.qrAsset as EventDefinition['qrAsset'],
    brandingAssets: item.brandingAssets as EventDefinition['brandingAssets'],
    slideAssets: item.slideAssets as EventDefinition['slideAssets'],
    caption: item.caption as EventDefinition['caption'],
    youtube: item.youtube as EventDefinition['youtube'],
    createdAtMs: item.createdAtMs as number,
    updatedAtMs: item.updatedAtMs as number,
  };
}

// --- 招待トークン記録 ---
export function inviteToItem(record: InviteTokenRecord): Item {
  return {
    pk: invitePk(record.jti),
    sk: 'META',
    type: 'invite',
    gsi1pk: `INVITE#${record.eventId}`,
    gsi1sk: record.jti,
    ...record,
  };
}

export function itemToInvite(item: Item): InviteTokenRecord {
  return {
    jti: item.jti as string,
    eventId: item.eventId as string,
    role: item.role as InviteTokenRecord['role'],
    currentVersion: item.currentVersion as number,
    revoked: item.revoked as boolean,
  };
}

// --- 発表状態 ---
export function presentationToItem(state: PresentationState): Item {
  return {
    pk: eventPk(state.eventId),
    sk: 'PRESENTATION',
    type: 'presentation',
    ...state,
  };
}

export function itemToPresentation(item: Item): PresentationState {
  return {
    eventId: item.eventId as string,
    speakers: (item.speakers as PresentationState['speakers']) ?? [],
    slideSource: item.slideSource as PresentationState['slideSource'],
    slidePage: item.slidePage as number | undefined,
  };
}
