// ─── NOMES CANÔNICOS DE EVENTO ──────────────────────────────────────────────
//
// Fonte única de verdade pros nomes que o app emite. Existe por causa de um bug
// real: a query de receita filtrava por `event = 'purchase'`, um nome que
// NENHUMA parte do sistema emitia. O funil dizia "3 assinaturas" e a receita
// dizia "R$ 0,00" ao mesmo tempo, e ninguém percebeu porque cada arquivo tinha
// a sua própria cópia da string.
//
// Enquanto os nomes viverem soltos dentro de SQL espalhado, esse bug volta.
// Aqui eles ficam num lugar só, e os dois drivers importam daqui.
//
// ⚠️ Estes valores são o CONTRATO com o app (`AnalyticsEvent` no Analytics.swift).
// Renomear qualquer um quebra a leitura dos eventos já gravados no banco —
// eventos antigos continuam com o nome antigo pra sempre.
// ────────────────────────────────────────────────────────────────────────────

export const EVENT = {
  // Funil
  paywallView: "paywall_view",
  checkoutInitiated: "checkout_initiated",
  subscribe: "subscribe",
  startTrial: "start_trial",

  // Sinal de produto (fora do funil)
  storyOpen: "story_open",
  storyComplete: "story_complete",
  narrationPlay: "narration_play",

  // Alarme de infra
  paywallProductsEmpty: "paywall_products_empty",

  /**
   * LEGADO. O app nunca emitiu isto — só o `scripts/seed.ts` antigo e qualquer
   * evento gravado à mão. Continua sendo somado na receita pra não apagar
   * histórico de bancos que já têm essas linhas.
   */
  purchase: "purchase",
} as const;

/**
 * Dinheiro que entrou de verdade.
 *
 * `start_trial` NÃO está aqui, de propósito. O app manda o preço cheio do
 * produto no `value` do trial (PaywallView.swift:309) porque o Meta CAPI
 * precisa dele pra otimizar campanha. Somar isso na receita contaria como
 * pago um dinheiro que ninguém pagou — e que boa parte nunca vai pagar, já
 * que trial tem cancelamento. Trial vira receita quando renova, e a renovação
 * chega como `subscribe`.
 */
export const REVENUE_EVENTS = [EVENT.subscribe, EVENT.purchase] as const;

/** Trials: fecham o funil, mas valem R$ 0,00 hoje. Contados à parte. */
export const TRIAL_EVENTS = [EVENT.startTrial] as const;

/** Quem chegou ao fim do funil, pagando ou em trial. */
export const CONVERSION_EVENTS = [EVENT.subscribe, EVENT.startTrial] as const;

/** Tudo que o funil precisa contar. */
export const FUNNEL_EVENTS = [
  EVENT.paywallView,
  EVENT.checkoutInitiated,
  ...CONVERSION_EVENTS,
] as const;

/** Eventos que carregam valor monetário (pagos + trials). */
export const MONETARY_EVENTS = [...REVENUE_EVENTS, ...TRIAL_EVENTS] as const;

/**
 * Monta a lista pra interpolar num `IN (...)`.
 *
 * Interpolar string em SQL normalmente é injection. Aqui não é: as únicas
 * entradas possíveis são as constantes deste arquivo, que são literais de
 * código. O escape de aspas fica mesmo assim, porque "nunca vai chegar dado
 * de fora aqui" é o tipo de premissa que envelhece mal.
 */
export function sqlList(events: readonly string[]): string {
  return events.map((e) => `'${e.replace(/'/g, "''")}'`).join(", ");
}
