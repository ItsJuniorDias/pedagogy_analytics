import type { FunnelResult } from "../db/types";
import { EVENT } from "./events";

// Monta o funil a partir das contagens brutas por evento.
//
// ⚠️ Como os eventos NÃO carregam id de usuário/sessão (design PII-free, seguro
// pra Kids), as taxas são razões de VOLUME de eventos, não conversão por
// usuário. Serve muito bem como sinal direcional. Se um dia você adicionar um
// "anon_id" gerado no device (não é IDFA), dá pra evoluir pra funil por sessão.
export function buildFunnel(
  from: number,
  to: number,
  counts: Record<string, number>,
): FunnelResult {
  const view = counts[EVENT.paywallView] ?? 0;
  const checkout = counts[EVENT.checkoutInitiated] ?? 0;
  // subscribe + start_trial: os dois fecharam o funil. Se você quiser separar
  // pago de trial, o número está em /stats/revenue (campos count e trials) —
  // aqui não, porque "converteu" no funil é chegar até o fim.
  const converted = (counts[EVENT.subscribe] ?? 0) + (counts[EVENT.startTrial] ?? 0);

  const pct = (a: number, b: number) =>
    b > 0 ? Math.round((a / b) * 1000) / 10 : 0;

  return {
    from,
    to,
    stages: { paywall_view: view, checkout_initiated: checkout, converted },
    rates: {
      viewToCheckout: pct(checkout, view),
      checkoutToConvert: pct(converted, checkout),
      viewToConvert: pct(converted, view),
    },
  };
}
