// Configuração via variáveis de ambiente (com defaults sãos pra rodar local).
export interface Config {
  port: number;
  host: string;
  nodeEnv: string;
  adminToken: string | null;
  ingestToken: string | null;
  databaseUrl: string | null;
  dbPath: string;
  rateLimitPerMin: number;
  corsOrigin: string;
  // Meta Conversions API (CAPI)
  metaDatasetId: string | null;
  metaCapiToken: string | null;
  metaApiVersion: string;
  metaTestEventCode: string | null;
  metaCapiEnabled: boolean;
  // App Store Server Notifications V2 (webhook de assinatura)
  appleBundleId: string | null;
  appleAppId: number | null;
  appleEnvironment: "Production" | "Sandbox";
  appleRootCertsDir: string;
  appleRootCertsB64: string | null;
  appleWebhookPath: string;
  appleOnlineChecks: boolean;
  appleSkipVerification: boolean;
  subHashSecret: string | null;
}

export const config: Config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "0.0.0.0",
  nodeEnv: process.env.NODE_ENV ?? "development",
  adminToken: process.env.ADMIN_TOKEN?.trim() || null,
  ingestToken: process.env.INGEST_TOKEN?.trim() || null,
  databaseUrl: process.env.DATABASE_URL?.trim() || null,
  dbPath: process.env.DB_PATH?.trim() || "./data/analytics.db",
  rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN ?? 300),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  metaDatasetId: process.env.META_DATASET_ID?.trim() || null,
  metaCapiToken: process.env.META_CAPI_TOKEN?.trim() || null,
  metaApiVersion: process.env.META_API_VERSION?.trim() || "v25.0",
  metaTestEventCode: process.env.META_TEST_EVENT_CODE?.trim() || null,
  metaCapiEnabled: Boolean(
    (process.env.META_DATASET_ID?.trim() || null) &&
      (process.env.META_CAPI_TOKEN?.trim() || null),
  ),

  appleBundleId: process.env.APPLE_BUNDLE_ID?.trim() || null,
  appleAppId: Number(process.env.APPLE_APP_ID) || null,
  // Qual ambiente este serviço aceita. A Apple manda sandbox e produção pra
  // URLs DIFERENTES, configuradas separadamente no App Store Connect — então
  // um serviço só precisa conhecer um. Misturar os dois faz o teste de
  // sandbox aparecer como venda real no dashboard.
  appleEnvironment:
    process.env.APPLE_ENVIRONMENT?.trim() === "Sandbox" ? "Sandbox" : "Production",
  appleRootCertsDir: process.env.APPLE_ROOT_CERTS_DIR?.trim() || "./certs/apple",
  appleRootCertsB64: process.env.APPLE_ROOT_CERTS_B64?.trim() || null,
  // Caminho do webhook. Dá pra trocar por algo não-adivinhável (ex.:
  // /apple/notifications/9f3c…) como camada extra — a verificação da
  // assinatura é que protege de verdade, isto só corta ruído de scanner.
  appleWebhookPath:
    process.env.APPLE_WEBHOOK_PATH?.trim() || "/apple/notifications",
  // Checagem online do certificado (OCSP + validade na data de hoje). Custa
  // uns milissegundos por notificação; desligue só se o Render estiver
  // estourando o timeout da Apple.
  appleOnlineChecks: process.env.APPLE_ONLINE_CHECKS !== "false",
  // Escape hatch pra rodar sem os .cer (ex.: testar o fluxo de ponta a ponta
  // antes de baixar os certificados). ⚠️ Sem verificação, QUALQUER UM que
  // descubra a URL escreve no seu banco. Nunca deixe ligado em produção.
  appleSkipVerification: process.env.APPLE_SKIP_VERIFICATION === "true",
  // Segredo do HMAC que vira o originalTransactionId em `sub_key`.
  // Trocar este valor faz o banco perder o vínculo com as assinaturas que já
  // existem — elas viram linhas órfãs. Defina uma vez e não mexa.
  subHashSecret:
    process.env.SUB_HASH_SECRET?.trim() ||
    process.env.ADMIN_TOKEN?.trim() ||
    null,
};

export const isProd = config.nodeEnv === "production";
