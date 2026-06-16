/**
 * ランタイム設定 (デプロイ手順 / DESIGN.md 3.1)。
 *
 * 本番は CDK BucketDeployment が S3 に置く `/config.json` を起動時に fetch して読む。
 * ビルド時に API URL / Cognito を焼き込まないので dist は環境非依存になり、`cdk deploy` だけで
 * 配信できる。config.json が取れない場合 (ローカル `vp dev` 等) は build-time の `import.meta.env`
 * にフォールバックする。
 */
export interface RuntimeConfig {
  /** 制御 API のベース URL (API Gateway エンドポイント)。 */
  controlApiUrl: string;
  /** Cognito Hosted UI 設定 (未設定なら認証なしで動く＝ローカル)。 */
  cognito?: { domain: string; clientId: string };
}

/** fetch した config.json (任意) と build-time env から最終設定を解決する (純粋関数・テスト対象)。 */
export function resolveRuntimeConfig(
  fetched: Partial<RuntimeConfig> | undefined,
  env: ImportMetaEnv,
): RuntimeConfig {
  const controlApiUrl = fetched?.controlApiUrl ?? env.VITE_CONTROL_API_URL ?? "";
  const cognito =
    fetched?.cognito ??
    (env.VITE_COGNITO_DOMAIN && env.VITE_COGNITO_USER_POOL_CLIENT_ID
      ? { domain: env.VITE_COGNITO_DOMAIN, clientId: env.VITE_COGNITO_USER_POOL_CLIENT_ID }
      : undefined);
  return cognito ? { controlApiUrl, cognito } : { controlApiUrl };
}

/** `/config.json` を読み込み、無ければ env にフォールバックして RuntimeConfig を返す。 */
export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  let fetched: Partial<RuntimeConfig> | undefined;
  try {
    const res = await fetch("/config.json", { cache: "no-store" });
    if (res.ok) fetched = (await res.json()) as Partial<RuntimeConfig>;
  } catch {
    // 未配置 / ネットワーク不通はローカル開発とみなし env フォールバック。
  }
  return resolveRuntimeConfig(fetched, import.meta.env);
}
