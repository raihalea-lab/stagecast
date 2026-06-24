/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CONTROL_API_URL?: string;
  /** R17-Phase3 / ADR 0012 D-6: composer-template の URL (iframe プレビュー埋め込み用)。 */
  readonly VITE_COMPOSER_TEMPLATE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
