/**
 * DynamoDB 実装のリポジトリ (DESIGN.md 3.1)。
 *
 * インメモリ実装と同じインターフェースを満たし、本番で差し替える。AWS SDK v3 の
 * DocumentClient を使用。マッピングは dynamo-mapper.ts の純粋関数に委譲する
 * (この層は SDK 呼び出しのみで、ロジックを持たない)。
 *
 * 注: 本ファイルは実 AWS に接続するため単体テスト対象外 (統合時に検証)。
 * ロジックは dynamo-mapper.test.ts で純粋関数として検証する。
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type { EventDefinition, PresentationState, SpeakerVisibility } from "@stagecast/shared";
import type {
  EventRepository,
  InviteTokenRecord,
  InviteTokenRepository,
  PresentationRepository,
} from "./types.js";
import {
  eventPk,
  eventToItem,
  invitePk,
  inviteToItem,
  itemToEvent,
  itemToInvite,
  itemToPresentation,
  presentationToItem,
} from "./dynamo-mapper.js";

export function createDocClient(client?: DynamoDBClient): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(client ?? new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

export class DynamoEventRepository implements EventRepository {
  constructor(
    private readonly table: string,
    private readonly doc = createDocClient(),
  ) {}

  async put(event: EventDefinition): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: eventToItem(event) }));
  }
  async get(eventId: string): Promise<EventDefinition | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { pk: eventPk(eventId), sk: "META" } }),
    );
    return res.Item ? itemToEvent(res.Item) : undefined;
  }
  async list(): Promise<EventDefinition[]> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": "EVENT" },
      }),
    );
    return (res.Items ?? []).map(itemToEvent);
  }
  async delete(eventId: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.table, Key: { pk: eventPk(eventId), sk: "META" } }),
    );
  }
}

export class DynamoInviteTokenRepository implements InviteTokenRepository {
  constructor(
    private readonly table: string,
    private readonly doc = createDocClient(),
  ) {}

  async put(record: InviteTokenRecord): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: inviteToItem(record) }));
  }
  async get(jti: string): Promise<InviteTokenRecord | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { pk: invitePk(jti), sk: "META" } }),
    );
    return res.Item ? itemToInvite(res.Item) : undefined;
  }
  async listByEvent(eventId: string): Promise<InviteTokenRecord[]> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": `INVITE#${eventId}` },
      }),
    );
    return (res.Items ?? []).map(itemToInvite);
  }
}

export class DynamoPresentationRepository implements PresentationRepository {
  constructor(
    private readonly table: string,
    private readonly doc = createDocClient(),
  ) {}

  async get(eventId: string): Promise<PresentationState | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { pk: eventPk(eventId), sk: "PRESENTATION" } }),
    );
    return res.Item ? itemToPresentation(res.Item) : undefined;
  }

  async setSpeakerVisibility(
    eventId: string,
    speakerId: string,
    visibility: SpeakerVisibility,
    nowMs: number,
  ): Promise<PresentationState> {
    const current = (await this.get(eventId)) ?? { eventId, speakers: [] };
    const existing = current.speakers.find((s) => s.speakerId === speakerId);
    if (existing) {
      existing.visibility = visibility;
      existing.updatedAtMs = nowMs;
    } else {
      current.speakers.push({ speakerId, visibility, updatedAtMs: nowMs });
    }
    await this.doc.send(
      new PutCommand({ TableName: this.table, Item: presentationToItem(current) }),
    );
    return current;
  }

  async setSlide(
    eventId: string,
    slide: Pick<PresentationState, "slideSource" | "slidePage">,
  ): Promise<PresentationState> {
    const current = (await this.get(eventId)) ?? { eventId, speakers: [] };
    current.slideSource = slide.slideSource;
    current.slidePage = slide.slidePage;
    await this.doc.send(
      new PutCommand({ TableName: this.table, Item: presentationToItem(current) }),
    );
    return current;
  }
}

/** DynamoDB 一式のリポジトリを生成する。 */
export function dynamoRepositories(table: string, client?: DynamoDBClient) {
  const doc = createDocClient(client);
  return {
    eventRepo: new DynamoEventRepository(table, doc),
    inviteRepo: new DynamoInviteTokenRepository(table, doc),
    presentationRepo: new DynamoPresentationRepository(table, doc),
  };
}
