/**
 * イベント定義とイベント設定 (DESIGN.md 8 章)。
 *
 * 管理者が配信前にイベント単位で準備・登録する。設定は DynamoDB に、
 * 素材 (QR・スライド等) は S3 に保存する。
 */
import type { LanguageCode } from "./caption.js";

/** イベントのライフサイクル状態 (DESIGN.md 7.1)。 */
export type EventStatus = "draft" | "scheduled" | "live" | "ended";

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
  createdAtMs: number;
  updatedAtMs: number;
}

/** 字幕設定の整合性を検証する (YouTube 送出言語は対応言語に含まれること)。 */
export function isValidCaptionSettings(s: CaptionSettings): boolean {
  return s.languages.length > 0 && s.languages.includes(s.youtubeLanguage);
}
