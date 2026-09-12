// ─── WEBHOOK: APP STORE SERVER NOTIFICATIONS V2 ─────────────────────────────
//
// É ISTO que o RevenueCat vende. A Apple faz POST aqui toda vez que alguma
// coisa acontece com uma assinatura — inclusive (e principalmente) quando a
// pessoa cancela, o que acontece em Ajustes → Apple ID → Assinaturas, um
// lugar onde o seu app não está e nunca vai estar.
//
// Por que não dá pra resolver no app:
//   • quem cancela um trial normalmente NÃO abre o app de novo. Checar o
//     StoreKit no launch só descobre o cancelamento de quem voltou — ou seja,
//     justamente a minoria que talvez nem tenha cancelado de verdade;
//   • renovação (a hora em que o trial vira dinheiro) roda no servidor da
//     Apple, sem device nenhum ligado;
//   • reembolso idem.
//
// Contrato com a Apple:
//   • corpo = { "signedPayload": "<JWS>" };
//   • 2xx = "recebi, pode parar". QUALQUER outra coisa = reenvio (até 5
//     tentativas, ao longo de ~3 dias). Então: erro nosso (banco fora) →
//     responde 500 DE PROPÓSITO, pra Apple trazer de volta. Payload que não
//     verifica → 401, porque reenviar não vai fazer verificar;
//   • a mesma notificação pode chegar duas vezes mesmo depois de um 200 —
//     `claimAppleNotification` (PK no notificationUUID) é o que segura isso.
// ────────────────────────────────────────────────────────────────────────────

import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";

import { config } from "../config";
import type { EventInput, SubscriptionPatch } from "../db/types";
import { fromMilliunits, isFreeTrial, toSubEvent } from "../lib/appleMap";
import {
  getAppleVerifier,
  type DecodedRenewalInfo,
  type DecodedTransaction,
} from "../lib/appleVerifier";
import { storefrontToAlpha2 } from "../lib/storefront";

/**
 * originalTransactionId → chave estável e anônima.
 *
 * O id cru da Apple NUNCA entra no banco. É um identificador permanente de
 * assinante, e o resto deste projeto foi construído sem identificador nenhum
 * (categoria Kids). HMAC com segredo do servidor preserva a única coisa que a
 * gente precisa — "é a mesma assinatura de antes?" — sem guardar o original.
 *
 * Pra investigar um caso: gere o HMAC do id que o cliente te mandar e procure.
 */
function subKey(originalTransactionId: string): string {
  const secret = config.subHashSecret ?? "";
  return crypto
    .createHmac("sha256", secret)
    .update(originalTransactionId)
    .digest("hex")
    .slice(0, 32);
}

export default async function appleNotificationRoutes(app: FastifyInstance) {
  const verifier = getAppleVerifier();

  if (!verifier.enabled) {
    app.log.warn(`[Apple] webhook DESLIGADO — ${verifier.reason}`);
  } else if (!verifier.verifying) {
    app.log.error(
      "[Apple] webhook ligado SEM VERIFICAR ASSINATURA (APPLE_SKIP_VERIFICATION=true). " +
        "Qualquer um que descobrir a URL escreve no seu banco. Só pra teste local.",
    );
  } else {
    app.log.info(
      `[Apple] webhook ativo em ${config.appleWebhookPath} ` +
        `(ambiente=${config.appleEnvironment}, bundle=${config.appleBundleId})`,
    );
  }

  app.post(config.appleWebhookPath, async (req, reply) => {
    if (!verifier.enabled) {
      // 503 e não 200: assim a Apple reenvia, e as notificações que chegarem
      // enquanto você ainda está configurando não se perdem.
      return reply.code(503).send({ error: verifier.reason });
    }

    const signedPayload = (req.body as { signedPayload?: unknown } | null)
      ?.signedPayload;
    if (typeof signedPayload !== "string") {
      return reply.code(400).send({ error: "signedPayload ausente." });
    }

    let notification;
    try {
      notification = await verifier.verifyNotification(signedPayload);
    } catch (err) {
      req.log.warn({ err }, "[Apple] payload não verificado — descartado");
      return reply.code(401).send({ error: "Payload inválido." });
    }

    const type = notification.notificationType ?? "UNKNOWN";
    const subtype = notification.subtype ?? null;
    const uuid = notification.notificationUUID ?? crypto.randomUUID();
    const now = Date.now();

    // Trava de reenvio. Feita ANTES de qualquer escrita: se a mesma
    // notificação voltar, ela para aqui e não duplica evento nem contador.
    let isNew: boolean;
    try {
      isNew = await app.store.claimAppleNotification(uuid, type, subtype, now);
    } catch (err) {
      req.log.error(err, "[Apple] falha ao registrar notificação");
      return reply.code(500).send({ error: "Erro interno." }); // Apple reenvia
    }
    if (!isNew) {
      req.log.info({ uuid, type }, "[Apple] notificação repetida — ignorada");
      return reply.code(200).send({ ok: true, duplicate: true });
    }

    // O botão "Enviar notificação de teste" do App Store Connect não tem
    // transação nenhuma junto. Vale registrar pra confirmar que a URL está
    // certa, e sair antes de tentar ler dados que não existem.
    if (type === "TEST") {
      await app.store.insert([
        {
          event: "apple_test_notification",
          params: { environment: notification.data?.environment ?? null },
          ts: now,
          receivedAt: now,
          country: null,
        },
      ]);
      req.log.info("[Apple] notificação de teste recebida — webhook OK");
      return reply.code(200).send({ ok: true, test: true });
    }

    let tx: DecodedTransaction = {};
    let renewal: DecodedRenewalInfo = {};
    try {
      if (notification.data?.signedTransactionInfo) {
        tx = await verifier.verifyTransaction(notification.data.signedTransactionInfo);
      }
      if (notification.data?.signedRenewalInfo) {
        renewal = await verifier.verifyRenewalInfo(notification.data.signedRenewalInfo);
      }
    } catch (err) {
      req.log.warn({ err, type }, "[Apple] transação/renovação não verificada");
      return reply.code(401).send({ error: "Transação inválida." });
    }

    const originalId = tx.originalTransactionId ?? renewal.originalTransactionId;
    if (!originalId) {
      req.log.warn({ type, subtype }, "[Apple] notificação sem originalTransactionId");
      return reply.code(200).send({ ok: true, ignored: true });
    }

    const key = subKey(originalId);

    // O estado ANTERIOR é o que responde "esse cancelamento foi de um trial ou
    // de um pagante?". A notificação da Apple, sozinha, não diz.
    let previous = null;
    try {
      previous = await app.store.getSubscription(key);
    } catch (err) {
      req.log.error(err, "[Apple] falha ao ler assinatura");
      return reply.code(500).send({ error: "Erro interno." });
    }

    const isTrialNow = isFreeTrial(tx);
    const wasTrial = previous?.is_trial ?? isTrialNow;
    const mapped = toSubEvent(type, subtype, isTrialNow, wasTrial);

    // Storefront = onde a pessoa PAGA (e em que moeda). É um país melhor que o
    // header de borda, que só diz de onde ela abriu o app.
    const country = storefrontToAlpha2(tx.storefront);
    const price = fromMilliunits(tx.price) ?? fromMilliunits(renewal.renewalPrice);
    const currency = tx.currency ?? renewal.currency ?? null;

    // Renovação e cancelamento carregam valor; o resto não deve poluir a
    // receita. Reembolso entra com valor positivo e é subtraído na query.
    const carregaValor =
      mapped.event === "sub_started" ||
      mapped.event === "sub_resubscribed" ||
      mapped.event === "sub_renewed" ||
      mapped.event === "sub_refunded";

    const baseParams: Record<string, unknown> = {
      source: "apple_webhook",
      notification_type: type,
      subtype,
      product_id: tx.productId ?? renewal.autoRenewProductId ?? null,
      environment: tx.environment ?? notification.data?.environment ?? null,
      storefront: country,
      expires_at: tx.expiresDate ?? null,
      expiration_intent: renewal.expirationIntent ?? null,
      in_trial: wasTrial,
    };
    if (carregaValor && price != null && currency) {
      baseParams.value = price;
      baseParams.currency = currency;
    }

    const nomes = [mapped.event, mapped.extra].filter(
      (n): n is string => typeof n === "string",
    );

    // `ts` = quando a Apple assinou, não quando o Render recebeu. Assim uma
    // notificação atrasada (ou reprocessada) cai no dia em que o fato
    // aconteceu, e não no dia em que o servidor acordou.
    const eventTs = notification.signedDate ?? tx.purchaseDate ?? now;

    const events: EventInput[] = nomes.map((event) => ({
      event,
      // Só o evento principal leva valor: o extra é um recorte do mesmo fato
      // (sub_trial_cancelled dentro de sub_cancelled). Repetir o valor nos
      // dois contaria a mesma venda duas vezes.
      params: event === mapped.event ? baseParams : { ...baseParams, value: undefined },
      ts: eventTs,
      receivedAt: now,
      country,
    }));

    const patch: SubscriptionPatch = {
      sub_key: key,
      product_id: tx.productId ?? renewal.autoRenewProductId ?? null,
      status: mapped.status,
      // `is_trial` só muda quando a notificação define alguma coisa: virou
      // pago (DID_RENEW depois de trial) ou começou um trial novo.
      is_trial:
        mapped.extra === "sub_trial_converted"
          ? false
          : mapped.event === "sub_trial_started"
            ? true
            : undefined,
      auto_renew:
        mapped.autoRenew ??
        (renewal.autoRenewStatus === undefined
          ? undefined
          : renewal.autoRenewStatus === 1),
      environment: tx.environment ?? notification.data?.environment ?? null,
      country,
      currency,
      price,
      started_at: tx.originalPurchaseDate ?? null,
      expires_at: tx.expiresDate ?? null,
      cancelled_at: mapped.event === "sub_cancelled" ? eventTs : null,
      expired_at: mapped.event === "sub_expired" ? eventTs : null,
      renewalsInc: mapped.event === "sub_renewed" ? 1 : 0,
      last_notification: subtype ? `${type}/${subtype}` : type,
      updated_at: now,
    };

    try {
      await app.store.insert(events);
      await app.store.upsertSubscription(patch);
    } catch (err) {
      req.log.error(err, "[Apple] falha ao gravar");
      return reply.code(500).send({ error: "Erro interno." }); // Apple reenvia
    }

    req.log.info(
      { type, subtype, events: nomes, product: patch.product_id },
      "[Apple] notificação processada",
    );
    return reply.code(200).send({ ok: true, events: nomes });
  });
}
