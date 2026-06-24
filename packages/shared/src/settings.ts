/**
 * 制御層の運用設定 (LiveKit / YouTube の認証情報) (ADR D-10, T7)。
 *
 * 値は Secrets Manager に保存し、制御 API 経由で運用者が更新できる。
 * 機密値を画面に読み戻すことはせず、設定済みかどうかと非機密のメタ情報だけを返す。
 */

/**
 * LiveKit の認証情報 (ADR 0008 D-7 で URL は per-event 化により削除)。
 *
 * apiKey/apiSecret は全 EventMediaStack の LiveKit Server が ECS Secret 経由で共有する
 * (ADR 0008 D-5)。URL は events.media.livekitUrl から per-event で解決される。
 */
export interface LiveKitCredentials {
  /** API キー。サーバ側 token mint で使用。 */
  apiKey: string;
  /** API シークレット。サーバ側 token mint で使用。 */
  apiSecret: string;
}

/**
 * YouTube Data API / OAuth / 配信用ストリームキーの認証情報。
 *
 * すべてのフィールドは optional で、指定されたフィールドのみ更新する (差分更新)。
 * フィールドを省略すると Secrets Manager に保存された既存値が保持される。
 * 例: ストリームキーだけを更新したい場合は `{ streamKey: "..." }` だけを送る。
 */
export interface YouTubeCredentials {
  /** YouTube Data API キー (視聴者数取得など)。 */
  apiKey?: string;
  /** OAuth クライアント ID (配信先連携)。 */
  oauthClientId?: string;
  /** OAuth クライアントシークレット。 */
  oauthClientSecret?: string;
  /**
   * 配信用ストリームキー (R12, ADR 0006 D-4)。Egress が RTMP 送出時に
   * `${event.youtube.rtmpUrl}/${streamKey}` の形で組み立てる。
   * `event.youtube.streamKeyRef` がこのフィールド名 (例: `streamKey`) を指す。
   */
  streamKey?: string;
}

/**
 * LiveKit 設定の状態 (機密値は返さない)。
 *
 * ADR 0008 D-7 により URL は per-event 化されたため、グローバル設定としての url は
 * 廃止された (旧 `url?: string` は削除)。configured は apiKey/apiSecret 両方が設定済みかを表す。
 */
export interface LiveKitSettingsStatus {
  /** apiKey/apiSecret が設定済みかどうか。 */
  configured: boolean;
}

/** YouTube 設定の状態 (機密値は一切返さない)。 */
export interface YouTubeSettingsStatus {
  /** apiKey / oauthClientId / oauthClientSecret 全てが設定済みかどうか。 */
  configured: boolean;
  /** 配信用ストリームキー (R12) が設定済みかどうか。 */
  streamKeyConfigured: boolean;
}
