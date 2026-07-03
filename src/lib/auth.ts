import type { FastifyReply, FastifyRequest } from "fastify";

import { config, isProd } from "../config";

// preHandler das rotas administrativas (/stats/* e /events GET).
// Regra: se ADMIN_TOKEN não estiver setado, libera em DEV e bloqueia em PROD.
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  const token = config.adminToken;

  if (!token) {
    if (isProd) {
      return reply
        .code(401)
        .send({ error: "ADMIN_TOKEN não configurado no servidor." });
    }
    return; // dev sem token: segue
  }

  const provided =
    bearer(req) ?? (req.headers["x-admin-token"] as string | undefined);

  if (provided !== token) {
    return reply.code(401).send({ error: "Não autorizado." });
  }
}

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers["authorization"];
  if (typeof h === "string" && h.startsWith("Bearer ")) return h.slice(7).trim();
  return undefined;
}
