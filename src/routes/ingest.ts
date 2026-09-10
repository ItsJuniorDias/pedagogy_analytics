import type { FastifyInstance } from "fastify";

import { config } from "../config";
import type { EventInput } from "../db/types";
import { mirrorEventsToMeta } from "../lib/capiMirror";
import { normalizeCountry } from "../lib/country";
import { rateLimit } from "../lib/ratelimit";

// Máximo de eventos por requisição (o app manda 1 por vez, mas aceitamos lote).
const MAX_BATCH = 50;

// Headers de geo que os edges põem na requisição. Lidos em ordem; o primeiro
// que devolver duas letras válidas vence.
//
// `cf-ipcountry` é o que importa aqui: o Render serve atrás da Cloudflare, que
// resolve o IP em país antes da requisição chegar no Fastify. Os outros são
// cortesia — se um dia você migrar de plataforma, não precisa mexer no código.
//
// Ninguém aqui olha `req.ip`. O IP não é lido, não é logado e não é gravado:
// o que entra no banco são duas letras, e só.
const COUNTRY_HEADERS = [
  "cf-ipcountry", // Cloudflare (Render)
  "x-vercel-ip-country", // Vercel
  "fastly-client-country", // Fastly
  "x-appengine-country", // Google App Engine
  "x-country-code", // genérico (nginx/traefik com GeoIP)
  "x-geo-country", // genérico
];

/** Lê o país da borda. Devolve null se nenhum header trouxe algo utilizável. */
function countryFromEdge(headers: Record<string, unknown>): string | null {
  for (const h of COUNTRY_HEADERS) {
    const code = normalizeCountry(headers[h]);
    if (code) return code;
  }
  return null;
}

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

    // Resolvido uma vez por requisição: todos os eventos do lote vieram da
    // mesma conexão, então o país é o mesmo pra todos.
    const edgeCountry = countryFromEdge(req.headers as Record<string, unknown>);

    const events: EventInput[] = [];
    for (const item of rawItems) {
      const e = normalize(item, now, edgeCountry);
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

function normalize(
  item: unknown,
  now: number,
  edgeCountry: string | null,
): EventInput | null {
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

  // O que o app manda ganha do que a borda deduziu. Hoje o app não manda nada
  // e isso sempre cai no header; se um dia você incluir o storefront do
  // StoreKit (`Storefront.current?.countryCode`) em `params.country`, ele passa
  // a valer sem precisar de deploy do backend.
  //
  // Vale a diferença: o header diz de onde a pessoa ABRIU o app; o storefront
  // diz onde ela PAGA. Pra decidir preço e campanha, o segundo manda mais.
  const country =
    normalizeCountry(params.country) ??
    normalizeCountry(params.storefront) ??
    edgeCountry;

  return { event, params, ts, receivedAt: now, country };
}
