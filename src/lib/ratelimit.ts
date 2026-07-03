import type { FastifyReply, FastifyRequest } from "fastify";

import { config } from "../config";

// Rate limit simples em memória (janela fixa de 1 min por IP). Suficiente pra
// proteger o endpoint público /events sem dependência extra. Em múltiplas
// instâncias, troque por um store compartilhado (ex.: Redis).
const hits = new Map<string, { count: number; resetAt: number }>();

export async function rateLimit(req: FastifyRequest, reply: FastifyReply) {
  const limit = config.rateLimitPerMin;
  if (!limit || limit <= 0) return; // desligado

  const ip = req.ip || "unknown";
  const now = Date.now();
  const rec = hits.get(ip);

  if (!rec || now > rec.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + 60_000 });
    return;
  }

  rec.count += 1;
  if (rec.count > limit) {
    return reply
      .code(429)
      .send({ error: "Muitas requisições. Tente novamente em instantes." });
  }
}

// Limpeza periódica pra o Map não crescer indefinidamente.
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of hits) if (now > rec.resetAt) hits.delete(ip);
}, 5 * 60_000).unref();
