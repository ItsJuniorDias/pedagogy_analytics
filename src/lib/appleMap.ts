// ─── APPLE → EVENTO INTERNO ─────────────────────────────────────────────────
//
// Traduz `notificationType` + `subtype` das App Store Server Notifications V2
// nos nomes de `SUB_EVENT`. É aqui que moram as duas distinções que quase todo
// dashboard caseiro erra:
//
//   1. CANCELAR ≠ EXPIRAR.
//      `DID_CHANGE_RENEWAL_STATUS/AUTO_RENEW_DISABLED` é o clique em "cancelar
//      assinatura". A pessoa CONTINUA com acesso até `expiresDate`. O acesso
//      só acaba no `EXPIRED`, que chega dias (ou 11 meses) depois. Contar os
//      dois como a mesma coisa infla o churn e esconde a janela de win-back —
//      que é exatamente o intervalo entre um e outro.
//
//   2. TRIAL CANCELADO ≠ ASSINANTE PAGO CANCELADO.
//      A notificação é idêntica nos dois casos. O que diferencia é o ESTADO da
//      assinatura naquele momento (está em trial?), que só existe se você
//      guardar — por isso `toSubEvent` recebe `wasTrial`.
//
// Tipos não mapeados são gravados mesmo assim (como `apple_<type>`), porque
// notificação silenciosamente descartada é dado perdido pra sempre: a Apple
// não reenvia depois que você respondeu 200.
// ────────────────────────────────────────────────────────────────────────────

import { SUB_EVENT } from "./events";

export interface SubEventResult {
  /** Evento principal. Sempre existe. */
  event: string;
  /** Evento extra (ex.: DID_RENEW que também é conversão de trial). */
  extra?: string;
  /** Novo status da assinatura, quando a notificação define um. */
  status?: SubStatus;
  /** `true` = renova sozinha; `false` = cancelada; `undefined` = não mudou. */
  autoRenew?: boolean;
}

export type SubStatus =
  | "active" // pagando e renovando
  | "trialing" // em período de trial
  | "cancelled" // renovação desligada, mas ainda com acesso
  | "expired" // acesso acabou
  | "billing_retry" // cobrança falhou, a Apple está tentando de novo
  | "refunded" // dinheiro devolvido
  | "revoked"; // perdeu o acesso (ex.: saiu do Compartilhamento Familiar)

/**
 * @param type     notificationType da Apple
 * @param subtype  subtype (pode vir vazio)
 * @param isTrial  a transação DESTA notificação é um trial gratuito?
 * @param wasTrial o estado que guardamos dizia que a assinatura estava em trial?
 */
export function toSubEvent(
  type: string,
  subtype: string | null,
  isTrial: boolean,
  wasTrial: boolean,
): SubEventResult {
  switch (type) {
    case "SUBSCRIBED":
      if (subtype === "RESUBSCRIBE") {
        return {
          event: SUB_EVENT.resubscribed,
          status: isTrial ? "trialing" : "active",
          autoRenew: true,
        };
      }
      return isTrial
        ? { event: SUB_EVENT.trialStarted, status: "trialing", autoRenew: true }
        : { event: SUB_EVENT.started, status: "active", autoRenew: true };

    case "DID_CHANGE_RENEWAL_STATUS":
      // ⭐ O evento que o projeto não tinha.
      if (subtype === "AUTO_RENEW_DISABLED") {
        return {
          event: SUB_EVENT.cancelled,
          // `cancelled` é sempre o total; o trial é marcado À PARTE, nunca no
          // lugar dele. Assim "quantos cancelaram" continua sendo uma soma só.
          extra: wasTrial ? SUB_EVENT.trialCancelled : undefined,
          status: "cancelled",
          autoRenew: false,
        };
      }
      if (subtype === "AUTO_RENEW_ENABLED") {
        return {
          event: SUB_EVENT.reactivated,
          status: wasTrial ? "trialing" : "active",
          autoRenew: true,
        };
      }
      // A Apple já mandou esta notificação sem subtype em alguns casos.
      // Sem saber o sentido da mudança, registrar sem mexer no status é mais
      // honesto do que chutar "cancelou".
      return { event: SUB_EVENT.cancelled };

    case "DID_RENEW":
      // Um DID_RENEW numa assinatura que estava em trial é O número que
      // interessa: trial → pago. Depois dele a assinatura não é mais trial.
      if (wasTrial) {
        return {
          event: SUB_EVENT.renewed,
          extra: SUB_EVENT.trialConverted,
          status: "active",
        };
      }
      if (subtype === "BILLING_RECOVERY") {
        return {
          event: SUB_EVENT.renewed,
          extra: SUB_EVENT.billingRecovered,
          status: "active",
        };
      }
      return { event: SUB_EVENT.renewed, status: "active" };

    case "EXPIRED":
    case "GRACE_PERIOD_EXPIRED":
      // Trial que expirou sem nunca ter renovado é o denominador da taxa de
      // conversão: são os trials que JÁ terminaram e não viraram dinheiro.
      return {
        event: SUB_EVENT.expired,
        extra: wasTrial ? SUB_EVENT.trialExpired : undefined,
        status: "expired",
        autoRenew: false,
      };

    case "DID_FAIL_TO_RENEW":
      // Churn INVOLUNTÁRIO: o cartão recusou, a pessoa não pediu pra sair.
      // Misturar com cancelamento voluntário faz você "resolver" o problema
      // errado — este se resolve com aviso de cobrança, não com desconto.
      return { event: SUB_EVENT.billingIssue, status: "billing_retry" };

    case "REFUND":
      return { event: SUB_EVENT.refunded, status: "refunded" };

    case "REFUND_REVERSED":
      return { event: SUB_EVENT.refundReversed, status: "active" };

    case "REVOKE":
      return { event: SUB_EVENT.revoked, status: "revoked", autoRenew: false };

    case "DID_CHANGE_RENEWAL_PREF":
      return { event: SUB_EVENT.planChanged };

    case "PRICE_INCREASE":
    case "PRICE_CHANGE":
      return { event: SUB_EVENT.priceIncrease };

    case "OFFER_REDEEMED":
      return { event: SUB_EVENT.offerRedeemed };

    case "TEST":
      return { event: SUB_EVENT.appleTest };

    default:
      // CONSUMPTION_REQUEST, RENEWAL_EXTENDED, METADATA_UPDATE, MIGRATION,
      // ONE_TIME_CHARGE… guarda com o nome cru em vez de jogar fora.
      return { event: `apple_${type.toLowerCase()}` };
  }
}

/**
 * A transação é de um trial gratuito?
 *
 * `offerType 1` = oferta introdutória, e `offerDiscountType FREE_TRIAL` é o
 * sabor "grátis" dela (os outros são PAY_AS_YOU_GO e PAY_UP_FRONT — pagos).
 * `price === 0` é a rede de segurança pra payloads antigos, que não traziam
 * `offerDiscountType`.
 */
export function isFreeTrial(tx: {
  offerType?: number | string;
  offerDiscountType?: string;
  price?: number;
}): boolean {
  if (tx.offerDiscountType === "FREE_TRIAL") return true;
  if (Number(tx.offerType) === 1 && (tx.price ?? 0) === 0) return true;
  return false;
}

/**
 * Preço da Apple → unidade monetária.
 *
 * A Apple manda `price` e `renewalPrice` em MILI-unidades: 4990 = R$ 4,99.
 * Gravar o número cru multiplica sua receita por mil, e o erro é do tipo que
 * passa despercebido até alguém comemorar o mês errado.
 */
export function fromMilliunits(price: unknown): number | null {
  return typeof price === "number" && Number.isFinite(price) ? price / 1000 : null;
}
