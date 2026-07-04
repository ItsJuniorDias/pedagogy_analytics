import { readFileSync } from "fs";
import { join } from "path";

import Fastify from "fastify";

import { config } from "./config";
import { createStore } from "./db";
import { MetaCapi } from "./lib/metaCapi";
import adminRoutes from "./routes/admin";
import healthRoutes from "./routes/health";
import ingestRoutes from "./routes/ingest";
import statsRoutes from "./routes/stats";

async function main() {
  const app = Fastify({
    logger: true,
    bodyLimit: 64 * 1024, // 64 KB por requisição
    trustProxy: true, // atrás do proxy do Render → req.ip correto
  });

  const store = createStore();
  await store.init();
  app.decorate("store", store);

  // Meta Conversions API (CAPI). Se faltar token, entra em modo no-op — nada quebra.
  const metaCapi = new MetaCapi({
    datasetId: config.metaDatasetId ?? "",
    accessToken: config.metaCapiToken ?? "",
    apiVersion: config.metaApiVersion,
    testEventCode: config.metaTestEventCode,
    enabled: config.metaCapiEnabled,
    logger: {
      info: (o, m) => app.log.info(o as object, m),
      warn: (o, m) => app.log.warn(o as object, m),
      error: (o, m) => app.log.error(o as object, m),
    },
  });
  app.decorate("metaCapi", metaCapi);
  if (config.metaCapiEnabled) {
    app.log.info(`[CAPI] ativo (dataset=${config.metaDatasetId})`);
  } else {
    app.log.warn("[CAPI] desativado — defina META_DATASET_ID e META_CAPI_TOKEN");
  }

  await app.register(healthRoutes);
  await app.register(ingestRoutes);
  await app.register(statsRoutes);
  await app.register(adminRoutes);

  // Dashboard: a PÁGINA é pública (só HTML/JS); os dados vêm dos /stats/*, que
  // exigem o token. O JS do dashboard pergunta o token e o envia nas chamadas.
  const dashboardHtml = loadDashboard();
  app.get("/", async (_req, reply) => {
    reply.type("text/html").send(dashboardHtml);
  });

  app.addHook("onClose", async () => {
    await store.close();
  });

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(
      `Pedagogy Analytics no ar em :${config.port} (driver=${store.driver})`,
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      await app.close();
      process.exit(0);
    });
  }
}

function loadDashboard(): string {
  try {
    return readFileSync(join(process.cwd(), "public", "index.html"), "utf8");
  } catch {
    return "<h1>Pedagogy Analytics</h1><p>dashboard (public/index.html) não encontrado.</p>";
  }
}

void main();
