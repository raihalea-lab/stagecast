/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CONTROL_API_URL?: string;
  /** Cognito Hosted UI のドメイン (例: stagecast-admin-123.auth.us-east-1.amazoncognito.com) */
  readonly VITE_COGNITO_DOMAIN?: string;
  /** Cognito User Pool App Client ID */
  readonly VITE_COGNITO_USER_POOL_CLIENT_ID?: string;
  /** OAuth callback URL (省略時は `${origin}/auth/callback`) */
  readonly VITE_COGNITO_REDIRECT_URI?: string;
  /** ログアウト後の遷移先 (省略時は `${origin}/`) */
  readonly VITE_COGNITO_LOGOUT_URI?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
