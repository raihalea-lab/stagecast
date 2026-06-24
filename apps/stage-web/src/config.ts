/**
 * ランタイム設定 (デプロイ手順 / DESIGN.md 3.1)。
 *
 * 本番は CDK BucketDeployment が S3 に置く `/config.json` を起動時に fetch して読む。
 * stage-web が必要とするのは制御 API の URL と (R17-Phase3) composer-template の URL。
 * 取得できない場合 (ローカル `vp dev` 等) は build-time の `import.meta.env` にフォールバック。
 */
export interface RuntimeConfig {
  controlApiUrl: string;
  /** R17-Phase3 / ADR 0012 D-6: 登壇者ビュー右下小窓プレビュー (iframe) の URL。 */
  composerTemplateUrl?: string;
}

/**
 * fetch した config.json (任意) と build-time env のフォールバック値から最終設定を解決する。
 * 純粋関数 (テスト対象)。`import.meta.env` の型に依存しないよう、env 値は呼び出し側で取り出して渡す。
 */
export function resolveRuntimeConfig(
  fetched: Partial<RuntimeConfig> | undefined,
  fallbackApiUrl: string | undefined,
  fallbackComposerUrl?: string | undefined,
): RuntimeConfig {
  const controlApiUrl = fetched?.controlApiUrl ?? fallbackApiUrl ?? "";
  const composerTemplateUrl = fetched?.composerTemplateUrl ?? fallbackComposerUrl;
  return composerTemplateUrl ? { controlApiUrl, composerTemplateUrl } : { controlApiUrl };
}

/** `/config.json` を読み込み、無ければ build-time env にフォールバックして RuntimeConfig を返す。 */
export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  let fetched: Partial<RuntimeConfig> | undefined;
  try {
    const res = await fetch("/config.json", { cache: "no-store" });
    if (res.ok) fetched = (await res.json()) as Partial<RuntimeConfig>;
  } catch {
    // 未配置 / ネットワーク不通はローカル開発とみなし env フォールバック。
  }
  return resolveRuntimeConfig(
    fetched,
    import.meta.env.VITE_CONTROL_API_URL,
    import.meta.env.VITE_COMPOSER_TEMPLATE_URL,
  );
}
