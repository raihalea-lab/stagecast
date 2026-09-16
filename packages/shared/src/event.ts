/**
 * イベント定義とイベント設定 (DESIGN.md 8 章)。
 *
 * 管理者が配信前にイベント単位で準備・登録する。設定は DynamoDB に、
 * 素材 (QR・スライド等) は S3 に保存する。
 */
import type { LanguageCode } from "./caption.js";

/**
 * イベントのライフサイクル状態 (DESIGN.md 7.1, ADR 0016)。
 * `warmup` は ADR 0015 Phase 4 で追加: 開始前にインフラを事前起動する状態。
 */
export type EventStatus = "draft" | "scheduled" | "warmup" | "live" | "ended";

/** 字幕エンジンの経路種別 (DESIGN.md 6.2)。 */
export type CaptionEngineKind = "transcribe" | "llm" | "self-hosted-asr";

/** 字幕出力先の種別 (DESIGN.md 6.3)。 */
export type CaptionSinkKind = "youtube" | "custom-api";

/** S3 に保存された素材への参照 (QR・背景・ロゴ・スライド等)。 */
export interface AssetRef {
  /** S3 オブジェクトキー。 */
  key: string;
  /** 任意の表示名。 */
  label?: string;
  contentType?: string;
}

/** 字幕に関するイベント設定 (DESIGN.md 8 章, 6 章)。 */
export interface CaptionSettings {
  /**
   * 字幕を出すか (ADR 0017 D-2)。`false` にすると CaptionWorker を起動しない。
   *
   * イベント 1 本あたりのコストが **約 35% 下がる**ので、字幕が要らない配信では切る。
   * **未指定は `true`** (既存イベントの字幕が黙って止まらないようにするため)。
   */
  enabled?: boolean;
  /** 対応言語の一覧 (最低限 ja/en)。 */
  languages: LanguageCode[];
  /** YouTube 字幕トラックへ送出する 1 言語 (DESIGN.md 2.3, 6.3.1)。 */
  youtubeLanguage: LanguageCode;
  /** 使用する ASR/翻訳エンジン経路。 */
  engine: CaptionEngineKind;
  /** 独自字幕配信 API を有効化するか (DESIGN.md 6.3.2・任意起動)。 */
  customApiEnabled: boolean;
}

/** YouTube Live の配信先設定 (DESIGN.md 8 章, F-6)。実値の鍵は Secrets で扱う。 */
export interface YouTubeTarget {
  /** RTMP 取り込み URL。 */
  rtmpUrl: string;
  /** ストリームキーの参照 (Secrets Manager / SSM の名前)。値そのものは保持しない。 */
  streamKeyRef: string;
}

/**
 * EventMediaStack 起動完了後にメディア層が公開する接続情報 (ADR 0008 D-1)。
 *
 * reconcile Lambda が ECS task の Public IP を取得して書き戻す。`/join` はこのフィールドを
 * 読んで stage-web に返す。status=live でも EventMediaStack 起動完了前は undefined。
 */
export interface EventMediaInfo {
  /**
   * LiveKit Server に登壇者が WebSocket 接続するための URL。
   * `wss://<TaskPublicIp>:7880` 形式 (NLB を経由しない、ADR 0008 D-4)。
   */
  livekitUrl: string;
  /** URL が確定し DynamoDB に書き戻されたエポックミリ秒。診断用。 */
  readyAt: number;
}

/**
 * EventMediaStack のプロビジョニング進捗 (ADR 0023 D-3)。
 *
 * CloudFormation の完了 = 配信可能ではない。特に Express モード (ADR 0023 D-1) では
 * CFN は「設定を適用した時点」で CREATE_COMPLETE を返し、ECS タスクはまだ起動途中である。
 * 管理画面が「どこまで進んだか」を出せるよう、reconcile が毎 tick この観測結果を書き戻す。
 */
export type ProvisioningPhase =
  /** スタックがまだ存在しない (作成要求前)。 */
  | "none"
  /** CloudFormation がスタックを作成/更新中。 */
  | "creating"
  /** スタックは完成したが ECS タスクがまだ RUNNING でない。 */
  | "starting"
  /** タスクが RUNNING かつ LiveKit URL が確定済み = 配信開始できる。 */
  | "ready"
  /** スタックが FAILED/ROLLBACK。次の tick で作り直される。 */
  | "failed"
  /** スタックを破棄中。 */
  | "deleting";

/** ECS サービス 1 つ分の観測結果 (desired と running の乖離が「起動待ち」を表す)。 */
export interface EcsServiceStatus {
  /** ECS service 名 (`sfu-{eventId}` / `captionworker-{eventId}` 等)。 */
  name: string;
  /** 期待タスク数。0 は事前プロビジョニング状態 (ADR 0016 D-4)。 */
  desiredCount: number;
  /** 実際に RUNNING なタスク数。 */
  runningCount: number;
  /** DescribeServices で見つからなかった (= スタック作成途中でまだ存在しない)。 */
  missing?: boolean;
}

/**
 * 管理画面に出すプロビジョニング状況 (ADR 0023 D-3)。reconcile Lambda が書き、
 * control-api の GET /events/:id がそのまま返す。
 */
export interface EventProvisioningInfo {
  phase: ProvisioningPhase;
  /** CloudFormation の生ステータス (`CREATE_IN_PROGRESS` 等)。診断用。 */
  stackStatus?: string;
  /** ECS サービスごとの desired/running。 */
  services: EcsServiceStatus[];
  /** LiveKit URL が確定済みか (= `media` フィールドが埋まっているか)。 */
  mediaReady: boolean;
  /** この観測を書き込んだエポックミリ秒。 */
  observedAtMs: number;
}

/** イベント定義 (DESIGN.md 8 章)。 */
export interface EventDefinition {
  /** イベント ID。 */
  id: string;
  /** イベントタイトル (オーバーレイにも表示, F-5)。 */
  title: string;
  /** 開催開始日時 (ISO 8601)。 */
  startsAt: string;
  /** 開催終了予定日時 (ISO 8601)。 */
  endsAt?: string;
  status: EventStatus;
  /** QR コード画像 (オーバーレイ表示用, F-5)。 */
  qrAsset?: AssetRef;
  /** 配信素材 (背景・ロゴ・テロップ等)。 */
  brandingAssets?: AssetRef[];
  /** 事前アップロードのスライド資料 (F-3, 5.2)。 */
  slideAssets?: AssetRef[];
  caption: CaptionSettings;
  youtube?: YouTubeTarget;
  /**
   * EventMediaStack 起動完了後のメディア層接続情報 (ADR 0008 D-1)。
   * status="draft"/"ended" や、status="live" でも起動完了前は undefined。
   */
  media?: EventMediaInfo;
  /**
   * メディア層の起動進捗 (ADR 0023 D-3)。reconcile が毎 tick 書き戻す観測値で、
   * 管理画面の「配信インフラ」カードがこれを表示する。
   */
  provisioning?: EventProvisioningInfo;
  createdAtMs: number;
  updatedAtMs: number;
}

/** 字幕設定の整合性を検証する (YouTube 送出言語は対応言語に含まれること)。 */
export function isValidCaptionSettings(s: CaptionSettings): boolean {
  // 字幕オフなら言語の整合は問わない (どれも使われないため)。
  // 設定自体は残しておき、オンに戻したときにそのまま効くようにする。
  if (s.enabled === false) return true;
  return s.languages.length > 0 && s.languages.includes(s.youtubeLanguage);
}

/** 字幕を出すか (未指定は有効, ADR 0017 D-2)。 */
export function isCaptionEnabled(s: CaptionSettings | undefined): boolean {
  return s?.enabled ?? true;
}

/** S3 に保存されたアセットのメタデータ。イベントに属さずグローバルライブラリとして管理。 */
export interface AssetMetadata {
  assetId: string;
  assetKey: string;
  filename: string;
  contentType: string;
  tags: string[];
  description?: string;
  size?: number;
  createdAt: string;
}

export type OverlayPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** 演出プリセットの設定 (discriminated union)。 */
export type EffectConfig =
  | {
      kind: "banner";
      text: string;
      subtext?: string;
      position: "bottom" | "top";
      autoHideMs?: number;
    }
  | {
      kind: "qr";
      url: string;
      position: OverlayPosition;
      sizePercent?: number;
      autoHideMs?: number;
    }
  | {
      kind: "image";
      assetKey: string;
      label: string;
      position: OverlayPosition;
      sizePercent?: number;
      autoHideMs?: number;
    }
  | {
      kind: "video";
      assetKey: string;
      label: string;
      position: OverlayPosition;
      sizePercent?: number;
      autoHideMs?: number;
    };

/** 永続化される演出プリセット (Phase 4)。 */
export interface Preset {
  presetId: string;
  eventId: string;
  config: EffectConfig;
  label: string;
  sortOrder: number;
  createdAt: string;
}
