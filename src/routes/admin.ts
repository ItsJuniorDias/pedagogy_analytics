import type { FastifyInstance } from "fastify";

import { requireAdmin } from "../lib/auth";

// String de confirmação obrigatória — evita disparo acidental (ex.: alguém
// abrindo a URL por engano). Só apaga se vier exatamente ?confirm=DELETE_ALL.
const CONFIRM = "DELETE_ALL";

// Operações administrativas destrutivas. Sempre atrás do requireAdmin.
export default async function adminRoutes(app: FastifyInstance) {
  // DELETE /admin/clear?confirm=DELETE_ALL  → apaga TODOS os eventos.
  // ⚠️ Irreversível. Protegido por admin token + confirmação explícita.
  app.delete("/admin/clear", { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q.confirm !== CONFIRM) {
      return reply.code(400).send({
        error: `Confirmação necessária. Repita com ?confirm=${CONFIRM}`,
      });
    }
    const deleted = await app.store.clear();
    req.log.warn({ deleted }, "eventos apagados via /admin/clear");
    return reply.send({ ok: true, deleted });
  });
}
