// Monta o bloco de assinaturas a partir de contagens cruas.
//
// Vive fora dos drivers pelo mesmo motivo que `funnel.ts`: SQLite e Postgres
// precisam devolver o MESMO número. Toda vez que a aritmética mora dentro do
// SQL, os dois divergem — foi assim que a receita ficou zerada por semanas.

import type { AppleRevenueRow, SubscriptionStats } from "../db/types";
import { SUB_EVENT } from "./events";

const pct = (a: number, b: number) =>
  b > 0 ? Math.round((a / b) * 1000) / 10 : 0;

export interface SubSnapshot {
  active: number;
  trialing: number;
  cancelPending: number;
  billingRetry: number;
  expired: number;
}

export function buildSubscriptionStats(
  from: number,
  to: number,
  snapshot: SubSnapshot,
  counts: Record<string, number>,
  revenue: AppleRevenueRow[],
): SubscriptionStats {
  const n = (k: string) => counts[k] ?? 0;

  const trialStarted = n(SUB_EVENT.trialStarted);
  const trialCancelled = n(SUB_EVENT.trialCancelled);
  const trialConverted = n(SUB_EVENT.trialConverted);
  const trialExpired = n(SUB_EVENT.trialExpired);

  const novas =
    n(SUB_EVENT.started) + trialStarted + n(SUB_EVENT.resubscribed);

  // Denominador dos trials RESOLVIDOS: converteu ou expirou. Quem ainda está
  // no meio do trial não entra — senão a taxa começa artificialmente baixa
  // todo dia e "melhora" sozinha conforme os trials vencem.
  const trialsResolvidos = trialConverted + trialExpired;

  return {
    from,
    to,
    now: snapshot,
    period: {
      [SUB_EVENT.started]: n(SUB_EVENT.started),
      [SUB_EVENT.trialStarted]: trialStarted,
      [SUB_EVENT.resubscribed]: n(SUB_EVENT.resubscribed),
      [SUB_EVENT.cancelled]: n(SUB_EVENT.cancelled),
      [SUB_EVENT.trialCancelled]: trialCancelled,
      [SUB_EVENT.reactivated]: n(SUB_EVENT.reactivated),
      [SUB_EVENT.renewed]: n(SUB_EVENT.renewed),
      [SUB_EVENT.trialConverted]: trialConverted,
      [SUB_EVENT.expired]: n(SUB_EVENT.expired),
      [SUB_EVENT.trialExpired]: trialExpired,
      [SUB_EVENT.billingIssue]: n(SUB_EVENT.billingIssue),
      [SUB_EVENT.refunded]: n(SUB_EVENT.refunded),
      [SUB_EVENT.revoked]: n(SUB_EVENT.revoked),
    },
    rates: {
      trialCancel: pct(trialCancelled, trialStarted),
      trialConversion: pct(trialConverted, trialsResolvidos),
      cancel: pct(n(SUB_EVENT.cancelled), novas),
    },
    revenue,
  };
}
