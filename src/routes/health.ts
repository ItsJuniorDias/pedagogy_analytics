import type { FastifyInstance } from "fastify";

// Health check (o Render usa isto pra saber que o serviço está de pé).
export default async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({
    ok: true,
    driver: app.store.driver,
    uptime: Math.round(process.uptime()),
  }));
}
