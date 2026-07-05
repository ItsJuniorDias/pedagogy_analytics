// Ponte entre os eventos do funil (do app) e o Meta CAPI.
//
// Os eventos in-app NÃO têm contraparte no pixel (o paywall não existe no site),
// então isto NÃO é deduplicação — é matching: casamos pelo fbc/fbp (capturados no
// site) + e-mail do responsável hasheado. Os identificadores viajam dentro do
// `params` do evento (o app pode incluí-los sem mudar o contrato do /events).

import type { FastifyInstance } from "fastify";

import type { EventInput } from "../db/types";
import type { MetaActionSource, MetaEventInput } from "./metaCapi";

interface MetaMap {
  name: string;
  source: MetaActionSource;
  isPurchase?: boolean;
}

// Eventos do app -> eventos padrão do Meta.
// action_source 'system_generated' = evento de backend (correto p/ dataset web,
// já que não há SDK/App Events). Trocar p/ 'website' aumenta match rate mas mente
// sobre a origem — só faça isso se o match ficar ruim demais e você comparar EMQ.
const EVENT_MAP: Record<string, MetaMap> = {
  paywall_view: { name: "ViewContent", source: "system_generated" },
  checkout_initiated: { name: "InitiateCheckout", source: "system_generated" },
  subscribe: { name: "Purchase", source: "system_generated", isPurchase: true },
  start_trial: { name: "StartTrial", source: "system_generated" },
};

export interface MirrorCtx {
  ip?: string | null;
  userAgent?: string | null;
}

const s = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

// Constrói o fbc a partir do fbclid quando o cookie _fbc não veio.
function buildFbc(p: Record<string, unknown>): string | null {
  const fbc = s(p.fbc) ?? s(p._fbc);
  if (fbc) return fbc;
  const fbclid = s(p.fbclid);
  return fbclid ? `fb.1.${Date.now()}.${fbclid}` : null;
}

/** Converte um EventInput do funil no formato do CAPI (ou null se não mapear). */
export function toMetaEvent(
  e: EventInput,
  ctx: MirrorCtx,
): MetaEventInput | null {
  const map = EVENT_MAP[e.event];
  if (!map) return null;

  const p = e.params ?? {};

  const email = s(p.email) ?? s(p.user_email) ?? s(p.parent_email);
  const externalId =
    s(p.external_id) ?? s(p.app_user_id) ?? s(p.rc_user_id) ?? s(p.anon_id);
  const value = num(p.value) ?? num(p.amount) ?? num(p._value);
  const currency = s(p.currency) ?? s(p.currencyCode) ?? "BRL";
  const productId = s(p.content_id) ?? s(p.product_id);

  // Dedup só importa p/ eventos que também disparam no pixel. Como estes são
  // in-app, o event_id serve p/ idempotência no reenvio (evita duplicata).
  const eventId = s(p.event_id) ?? `${e.event}:${externalId ?? "anon"}:${e.ts}`;

  return {
    eventName: map.name,
    eventId,
    // usa receivedAt (relógio do servidor) p/ não tomar rejeição por "event_time
    // no futuro" quando o relógio do device estiver errado.
    eventTime: Math.floor(e.receivedAt / 1000),
    actionSource: map.source,
    userData: {
      email,
      externalId,
      fbc: buildFbc(p),
      fbp: s(p.fbp) ?? s(p._fbp),
      clientIpAddress: ctx.ip ?? null,
      clientUserAgent: ctx.userAgent ?? null,
    },
    customData: map.isPurchase
      ? {
          value: value ?? 0,
          currency,
          contentIds: productId ? [productId] : undefined,
          contentType: productId ? "product" : undefined,
        }
      : productId
        ? { contentIds: [productId], contentType: "product" }
        : undefined,
  };
}

/**
 * Espelha um lote de eventos p/ o Meta. Best-effort: chame com `void ... .catch`
 * pra NÃO bloquear a resposta do /events. Se o CAPI estiver desativado, é no-op.
 */
export async function mirrorEventsToMeta(
  app: FastifyInstance,
  events: EventInput[],
  ctx: MirrorCtx,
): Promise<void> {
  const mapped = events
    .map((e) => toMetaEvent(e, ctx))
    .filter((x): x is MetaEventInput => x !== null);

  if (mapped.length === 0) return;

  const res = await app.metaCapi.sendBatch(mapped);
  if (!res.ok && !res.skipped) {
    app.log.warn({ error: res.error }, "[CAPI] espelhamento falhou");
  }
}
