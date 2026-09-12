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

// ─── CICLO DE VIDA DA ASSINATURA (origem: APPLE, não o app) ─────────────────
//
// Estes NÃO vêm do device. Vêm do webhook `/apple/notifications`, alimentado
// pelas App Store Server Notifications V2. Existem porque o app é cego pra
// tudo que acontece depois da compra:
//
//   • cancelar é em Ajustes → Apple ID → Assinaturas, FORA do app;
//   • quem cancela costuma nunca mais abrir o app, então nenhuma checagem
//     no launch pega isso de forma confiável;
//   • renovação (mês 2, ano 2) acontece no servidor da Apple, sem device
//     envolvido — `subscribe` só dispara na PRIMEIRA compra;
//   • reembolso idem.
//
// O prefixo `sub_` separa origem: `subscribe`/`start_trial` são o que o app
// VIU acontecer; `sub_*` é o que a Apple CONFIRMA que aconteceu. Nunca some
// os dois na mesma conta de receita — a mesma venda gera um de cada.
// ────────────────────────────────────────────────────────────────────────────

export const SUB_EVENT = {
  /** SUBSCRIBED/INITIAL_BUY sem oferta de trial — já entrou pagando. */
  started: "sub_started",
  /** SUBSCRIBED/INITIAL_BUY com oferta de trial gratuito. */
  trialStarted: "sub_trial_started",
  /** SUBSCRIBED/RESUBSCRIBE — voltou depois de ter saído. */
  resubscribed: "sub_resubscribed",

  /**
   * ⭐ O evento que faltava. DID_CHANGE_RENEWAL_STATUS/AUTO_RENEW_DISABLED.
   * A pessoa desligou a renovação. ATENÇÃO: ela CONTINUA com acesso até
   * `expires_at` — cancelar não é expirar. Ver `expired`.
   */
  cancelled: "sub_cancelled",
  /**
   * Subconjunto de `cancelled`: cancelou ESTANDO EM TRIAL. Sempre vem junto
   * com `cancelled` (que é o total), nunca no lugar dele. Separado porque a
   * notificação da Apple é idêntica nos dois casos e as duas coisas pedem
   * reações opostas: trial cancelado é problema de onboarding/valor percebido
   * na primeira semana; assinante pago cancelado é problema de retenção.
   */
  trialCancelled: "sub_trial_cancelled",
  /** Cancelou e voltou atrás antes de expirar (AUTO_RENEW_ENABLED). */
  reactivated: "sub_reactivated",

  /** DID_RENEW — cobrou de novo. É receita de verdade. */
  renewed: "sub_renewed",
  /** Primeiro DID_RENEW depois de um trial: o trial virou dinheiro. */
  trialConverted: "sub_trial_converted",

  /** EXPIRED / GRACE_PERIOD_EXPIRED — o acesso acabou de fato. */
  expired: "sub_expired",
  /** Subconjunto de `expired`: o trial acabou sem virar pagamento nenhum. */
  trialExpired: "sub_trial_expired",
  /** DID_FAIL_TO_RENEW — cartão recusado. Churn involuntário, recuperável. */
  billingIssue: "sub_billing_issue",
  /** DID_RENEW/BILLING_RECOVERY — o cartão passou depois da falha. */
  billingRecovered: "sub_billing_recovered",

  /** REFUND — a Apple devolveu o dinheiro. Receita NEGATIVA. */
  refunded: "sub_refunded",
  /** REFUND_REVERSED — a Apple desfez o reembolso (estorno do estorno). */
  refundReversed: "sub_refund_reversed",
  /** REVOKE — saiu do Compartilhamento Familiar e perdeu o acesso. */
  revoked: "sub_revoked",

  /** DID_CHANGE_RENEWAL_PREF — trocou de plano (upgrade/downgrade). */
  planChanged: "sub_plan_changed",
  /** PRICE_INCREASE — aumento de preço proposto/aceito. */
  priceIncrease: "sub_price_increase",
  /** OFFER_REDEEMED — resgatou código promocional / oferta. */
  offerRedeemed: "sub_offer_redeemed",

  /** TEST — o botão "Enviar notificação de teste" do App Store Connect. */
  appleTest: "apple_test_notification",
} as const;

/** Os dois jeitos de uma assinatura começar contando como trial. */
export const TRIAL_START_EVENTS = [
  EVENT.startTrial,
  SUB_EVENT.trialStarted,
] as const;

/** Saídas confirmadas pela Apple. Cancelamento NÃO está aqui: quem cancelou
 *  ainda tem acesso, e pode voltar atrás antes de expirar. */
export const CHURN_EVENTS = [
  SUB_EVENT.expired,
  SUB_EVENT.revoked,
] as const;

/** Dinheiro confirmado pela Apple (NÃO misturar com REVENUE_EVENTS do app). */
export const APPLE_REVENUE_EVENTS = [
  SUB_EVENT.started,
  SUB_EVENT.resubscribed,
  SUB_EVENT.renewed,
] as const;

/** Dinheiro que a Apple devolveu. Entra com sinal trocado no líquido. */
export const APPLE_REFUND_EVENTS = [SUB_EVENT.refunded] as const;

/** Tudo que o webhook pode gravar — usado pra separar origem nas queries. */
export const SUB_EVENTS = Object.values(SUB_EVENT);

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
