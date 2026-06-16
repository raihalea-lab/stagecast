/**
 * 制御層の運用設定 (LiveKit / YouTube の認証情報) (ADR D-10, T7)。
 *
 * 値は Secrets Manager に保存し、制御 API 経由で運用者が更新できる。
 * 機密値を画面に読み戻すことはせず、設定済みかどうかと非機密のメタ情報だけを返す。
 */

/** LiveKit サーバの接続情報。 */
export interface LiveKitCredentials {
  /** WebSocket URL (wss://...)。stage-web が直接接続する。 */
  url: string;
  /** API キー。サーバ側 token mint で使用。 */
  apiKey: string;
  /** API シークレット。サーバ側 token mint で使用。 */
  apiSecret: string;
}

/** YouTube Data API / OAuth クライアントの認証情報。 */
export interface YouTubeCredentials {
  /** YouTube Data API キー (視聴者数取得など)。 */
  apiKey: string;
  /** OAuth クライアント ID (配信先連携)。 */
  oauthClientId: string;
  /** OAuth クライアントシークレット。 */
  oauthClientSecret: string;
}

/** LiveKit 設定の状態 (機密値は返さない。url のみ公開)。 */
export interface LiveKitSettingsStatus {
  /** 全フィールドが設定済みかどうか。 */
  configured: boolean;
  /** 設定済みの場合のみ url を公開 (URL は機密でないため運用者が確認できる)。 */
  url?: string;
}

/** YouTube 設定の状態 (機密値は一切返さない)。 */
export interface YouTubeSettingsStatus {
  /** 全フィールドが設定済みかどうか。 */
  configured: boolean;
}
