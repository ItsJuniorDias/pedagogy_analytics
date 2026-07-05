import type { FastifyInstance } from "fastify";

import { config } from "../config";
import type { EventInput } from "../db/types";
import { mirrorEventsToMeta } from "../lib/capiMirror";
import { rateLimit } from "../lib/ratelimit";

// Máximo de eventos por requisição (o app manda 1 por vez, mas aceitamos lote).
const MAX_BATCH = 50;

// POST /events — é o alvo do ANALYTICS_ENDPOINT do app.
// Recebe { event, params, ts } (ou um array desses).
export default async function ingestRoutes(app: FastifyInstance) {
  // CORS mínimo só pro /events (útil pro Expo web; app nativo ignora CORS).
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/events")) {
      reply.header("Access-Control-Allow-Origin", config.corsOrigin);
      reply.header("Access-Control-Allow-Headers", "Content-Type, x-api-key");
      reply.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    }
  });

  app.options("/events", async (_req, reply) => reply.code(204).send());

  app.post("/events", { preHandler: rateLimit }, async (req, reply) => {
    // Auth opcional de ingest (só se INGEST_TOKEN estiver setado).
    if (config.ingestToken) {
      const key = req.headers["x-api-key"];
      if (key !== config.ingestToken) {
        return reply.code(401).send({ error: "Chave de ingest inválida." });
      }
    }

    const now = Date.now();
    const body = req.body as unknown;
    const rawItems = Array.isArray(body) ? body : [body];

    if (rawItems.length === 0) {
      return reply.code(400).send({ error: "Corpo vazio." });
    }
    if (rawItems.length > MAX_BATCH) {
      return reply
        .code(413)
        .send({ error: `Máximo de ${MAX_BATCH} eventos por requisição.` });
    }

    const events: EventInput[] = [];
    for (const item of rawItems) {
      const e = normalize(item, now);
      if (e) events.push(e);
    }

    if (events.length === 0) {
      return reply
        .code(400)
        .send({ error: 'Nenhum evento válido (o campo "event" é obrigatório).' });
    }

    try {
      await app.store.insert(events);
    } catch (err) {
      req.log.error(err, "falha ao gravar eventos");
      return reply.code(500).send({ error: "Erro ao gravar eventos." });
    }

    // Espelha p/ o Meta CAPI (best-effort — não bloqueia nem derruba o /events).
    void mirrorEventsToMeta(app, events, {
      ip: req.ip,
      userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
    }).catch((err) => req.log.error(err, "[CAPI] espelhamento falhou"));

    return reply.code(202).send({ ok: true, accepted: events.length });
  });
}

function normalize(item: unknown, now: number): EventInput | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const obj = item as Record<string, unknown>;

  const event =
    typeof obj.event === "string" && obj.event.length > 0
      ? obj.event.slice(0, 120)
      : null;
  if (!event) return null;

  const params =
    obj.params && typeof obj.params === "object" && !Array.isArray(obj.params)
      ? (obj.params as Record<string, unknown>)
      : {};

  const ts =
    typeof obj.ts === "number" && Number.isFinite(obj.ts) ? obj.ts : now;

  return { event, params, ts, receivedAt: now };
}
