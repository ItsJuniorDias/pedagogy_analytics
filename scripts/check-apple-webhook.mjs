#!/usr/bin/env node
// Teste de ponta a ponta do webhook da Apple, sem precisar da Apple.
//
// Sobe o servidor em SQLite temporário com APPLE_SKIP_VERIFICATION=true, manda
// as notificações que mais importam e confere os números que saem do
// /stats/subscriptions. Roda junto do `npm run typecheck` — o webhook é o tipo
// de código que passa no compilador e erra o que interessa (cancelamento
// contado como expiração, trial contado duas vezes, reenvio duplicando).
//
//   node scripts/check-apple-webhook.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 3199;
const TOKEN = "teste-local";
const dir = mkdtempSync(join(tmpdir(), "pedagogy-apple-"));

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jws = (payload) => `${b64({ alg: "none" })}.${b64(payload)}.x`;

let uuidSeq = 0;
const notificacao = (type, subtype, tx = {}, renewal = {}, uuid = null) => ({
  signedPayload: jws({
    notificationType: type,
    subtype,
    notificationUUID: uuid ?? `uuid-${++uuidSeq}`,
    signedDate: Date.now(),
    data: {
      environment: "Production",
      bundleId: "com.teste.pedagogy",
      signedTransactionInfo: jws({
        originalTransactionId: "2000000999",
        transactionId: `tx-${uuidSeq}`,
        productId: "annual_pedagogy",
        originalPurchaseDate: Date.now(),
        expiresDate: Date.now() + 7 * 86400_000,
        storefront: "BRA",
        currency: "BRL",
        price: 99900, // mili-unidades → R$ 99,90
        ...tx,
      }),
      signedRenewalInfo: jws({
        originalTransactionId: "2000000999",
        autoRenewProductId: "annual_pedagogy",
        autoRenewStatus: 1,
        ...renewal,
      }),
    },
  }),
});

const trial = { offerType: 1, offerDiscountType: "FREE_TRIAL", price: 0 };

const server = spawn("npx", ["tsx", "src/server.ts"], {
  env: {
    ...process.env,
    PORT: String(PORT),
    NODE_ENV: "development",
    ADMIN_TOKEN: TOKEN,
    DB_PATH: join(dir, "test.db"),
    DATABASE_URL: "",
    APPLE_BUNDLE_ID: "com.teste.pedagogy",
    APPLE_SKIP_VERIFICATION: "true",
    RATE_LIMIT_PER_MIN: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

const logs = [];
server.stdout.on("data", (d) => logs.push(String(d)));
server.stderr.on("data", (d) => logs.push(String(d)));

const limpar = () => {
  server.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
};

const falhar = (msg) => {
  console.error(`\n✗ ${msg}`);
  console.error("\n--- log do servidor ---\n" + logs.join(""));
  limpar();
  process.exit(1);
};

async function esperarServidor() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return;
    } catch {
      /* ainda subindo */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  falhar("o servidor não subiu em 15s");
}

const enviar = (body) =>
  fetch(`http://127.0.0.1:${PORT}/apple/notifications`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const stats = async () => {
  const r = await fetch(
    `http://127.0.0.1:${PORT}/stats/subscriptions?from=0&to=${Date.now() + 86400_000}`,
    { headers: { Authorization: `Bearer ${TOKEN}` } },
  );
  if (!r.ok) falhar(`/stats/subscriptions devolveu HTTP ${r.status}`);
  return r.json();
};

const checar = (nome, real, esperado) => {
  if (real !== esperado) falhar(`${nome}: esperado ${esperado}, veio ${real}`);
  console.log(`  ✓ ${nome} = ${real}`);
};

await esperarServidor();
console.log("servidor no ar\n");

// ── 1. começou um trial ──────────────────────────────────────────────────
await enviar(notificacao("SUBSCRIBED", "INITIAL_BUY", trial));
let s = await stats();
console.log("trial iniciado:");
checar("sub_trial_started", s.period.sub_trial_started, 1);
checar("em trial agora", s.now.trialing, 1);

// ── 2. cancelou DENTRO do trial ──────────────────────────────────────────
await enviar(notificacao("DID_CHANGE_RENEWAL_STATUS", "AUTO_RENEW_DISABLED", trial, {
  autoRenewStatus: 0,
}));
s = await stats();
console.log("\ncancelamento no trial:");
checar("sub_cancelled (total)", s.period.sub_cancelled, 1);
checar("sub_trial_cancelled (recorte)", s.period.sub_trial_cancelled, 1);
// A checagem que mais importa: cancelar NÃO é expirar. A pessoa ainda tem
// acesso, e é justamente aqui que win-back ainda funciona.
checar("sub_expired ainda em zero", s.period.sub_expired, 0);
checar("cancelou mas tem acesso", s.now.cancelPending, 1);
checar("taxa de cancelamento de trial", s.rates.trialCancel, 100);

// ── 3. reenvio da MESMA notificação (a Apple faz isso) ───────────────────
await enviar(notificacao("DID_CHANGE_RENEWAL_STATUS", "AUTO_RENEW_DISABLED", trial, {}, "uuid-2"));
s = await stats();
console.log("\nreenvio da mesma notificação:");
checar("sub_cancelled continua 1", s.period.sub_cancelled, 1);

// ── 4. o trial expirou sem pagar ─────────────────────────────────────────
await enviar(notificacao("EXPIRED", "VOLUNTARY", trial, { expirationIntent: 1 }));
s = await stats();
console.log("\ntrial expirado:");
checar("sub_expired", s.period.sub_expired, 1);
checar("sub_trial_expired", s.period.sub_trial_expired, 1);
checar("conversão de trial", s.rates.trialConversion, 0);

// ── 5. outra assinatura: trial que VIROU dinheiro ────────────────────────
const outra = { originalTransactionId: "2000000111" };
await enviar(notificacao("SUBSCRIBED", "INITIAL_BUY", { ...trial, ...outra }, outra));
await enviar(notificacao("DID_RENEW", null, outra, outra));
s = await stats();
console.log("\ntrial convertido:");
checar("sub_trial_converted", s.period.sub_trial_converted, 1);
checar("sub_renewed", s.period.sub_renewed, 1);
// 1 convertido de 2 trials que já terminaram (1 expirou, 1 converteu).
checar("conversão de trial", s.rates.trialConversion, 50);
checar("assinatura ativa", s.now.active, 1);

const brl = s.revenue.find((r) => r.currency === "BRL");
if (!brl) falhar("receita em BRL não apareceu");
// price 99900 mili-unidades = R$ 99,90 — e não R$ 99.900,00.
checar("receita bruta (BRL)", brl.gross, 99.9);

console.log("\n✓ webhook da Apple OK");
limpar();
process.exit(0);
