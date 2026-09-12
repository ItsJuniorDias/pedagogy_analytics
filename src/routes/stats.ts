import type { FastifyInstance, FastifyRequest } from "fastify";

import { requireAdmin } from "../lib/auth";

// Rotas de leitura do funil/estatística. Todas protegidas por requireAdmin.
// Aceitam ?from= e ?to= (epoch ms OU ISO). Default: últimos 7 dias.
export default async function statsRoutes(app: FastifyInstance) {
  const guard = { preHandler: requireAdmin };

  app.get("/stats/funnel", guard, async (req) => {
    const { from, to } = range(req);
    return app.store.funnel(from, to);
  });

  app.get("/stats/events", guard, async (req) => {
    const { from, to } = range(req);
    return { from, to, events: await app.store.eventCounts(from, to) };
  });

  app.get("/stats/revenue", guard, async (req) => {
    const { from, to } = range(req);
    return { from, to, revenue: await app.store.revenue(from, to) };
  });

  // Países, do maior volume de paywall_view pro menor. Cada linha já vem com
  // bandeira e nome — o cliente não precisa de tabela de países.
  app.get("/stats/countries", guard, async (req) => {
    const { from, to } = range(req);
    return { from, to, countries: await app.store.countries(from, to) };
  });

  // Ciclo de vida das assinaturas (origem: webhook da Apple).
  //
  // Separado de /stats/revenue de propósito: a MESMA venda gera um `subscribe`
  // do app e um `sub_started` da Apple. Somar os dois dobra a receita. Aqui os
  // números são os da Apple — os únicos que sabem de renovação, cancelamento e
  // reembolso; lá são os do app, que enxerga o funil até o botão de compra.
  app.get("/stats/subscriptions", guard, async (req) => {
    const { from, to } = range(req);
    return app.store.subscriptionStats(from, to);
  });

  // Tudo de uma vez — é o que o dashboard consome.
  app.get("/stats/overview", guard, async (req) => {
    const { from, to } = range(req);
    const [funnel, events, revenue, countries, subscriptions] = await Promise.all([
      app.store.funnel(from, to),
      app.store.eventCounts(from, to),
      app.store.revenue(from, to),
      app.store.countries(from, to),
      app.store.subscriptionStats(from, to),
    ]);
    return { from, to, funnel, events, revenue, countries, subscriptions };
  });

  // Eventos crus (debug).
  app.get("/events", guard, async (req) => {
    const q = req.query as Record<string, string>;
    const limit = clamp(Number(q.limit ?? 50), 1, 500);
    const offset = Math.max(0, Number(q.offset ?? 0));
    return { limit, offset, events: await app.store.recent(limit, offset) };
  });
}

function range(req: FastifyRequest): { from: number; to: number } {
  const q = req.query as Record<string, string>;
  const now = Date.now();
  const to = parseTs(q.to) ?? now;
  const from = parseTs(q.from) ?? now - 7 * 24 * 60 * 60 * 1000;
  return { from, to };
}

function parseTs(v?: string): number | null {
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
