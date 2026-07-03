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
};

export const isProd = config.nodeEnv === "production";
