import type { FunnelResult } from "../db/types";

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
  const view = counts["paywall_view"] ?? 0;
  const checkout = counts["checkout_initiated"] ?? 0;
  const converted = (counts["subscribe"] ?? 0) + (counts["start_trial"] ?? 0);

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
