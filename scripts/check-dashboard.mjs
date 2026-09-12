// Roda o <script> do dashboard fora do browser, com DOM e fetch falsos.
// Serve pra pegar erro de RUNTIME (não só de sintaxe) em cada render.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "public", "index.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

const els = {};
function el(id) {
  if (!els[id]) {
    els[id] = {
      id,
      innerHTML: "",
      textContent: "",
      className: "",
      value: "",
      dataset: {},
      classList: { toggle() {}, add() {}, remove() {} },
    };
  }
  return els[id];
}

// Payload realista do /stats/overview, com os casos que quebram:
// país sem código, moeda múltipla, trials, país com pouca amostra.
const OVERVIEW = {
  from: Date.now() - 7 * 864e5,
  to: Date.now(),
  funnel: {
    stages: { paywall_view: 210, checkout_initiated: 48, converted: 11 },
    rates: { viewToCheckout: 22.9, checkoutToConvert: 22.9, viewToConvert: 5.2 },
  },
  events: [
    { event: "paywall_view", count: 210 },
    { event: "story_open", count: 830 },
  ],
  revenue: [
    { currency: "USD", total: 34.93, count: 7, trials: 3, trialValue: 14.97 },
    { currency: "BRL", total: 199.8, count: 2, trials: 1, trialValue: 99.9 },
  ],
  countries: [
    { code: "US", flag: "🇺🇸", name: "Estados Unidos", events: 420, paywall_views: 96, converted: 6, rate: 6.3 },
    { code: "BR", flag: "🇧🇷", name: "Brasil", events: 300, paywall_views: 74, converted: 3, rate: 4.1 },
    { code: null, flag: "🏳️", name: "Desconhecido", events: 60, paywall_views: 32, converted: 1, rate: 3.1 },
    { code: "JP", flag: "🇯🇵", name: "Japão", events: 12, paywall_views: 8, converted: 1, rate: 12.5 },
  ],
  // Ciclo de vida vindo do webhook da Apple. Inclui os casos chatos:
  // cancelamento que ainda não expirou, reembolso e mais de uma moeda.
  subscriptions: {
    now: { active: 9, trialing: 4, cancelPending: 3, billingRetry: 1, expired: 12 },
    period: {
      sub_started: 2, sub_trial_started: 6, sub_resubscribed: 1,
      sub_cancelled: 4, sub_trial_cancelled: 3, sub_reactivated: 1,
      sub_renewed: 5, sub_trial_converted: 2,
      sub_expired: 3, sub_trial_expired: 2,
      sub_billing_issue: 1, sub_refunded: 1, sub_revoked: 0,
    },
    rates: { trialCancel: 50, trialConversion: 50, cancel: 44.4 },
    revenue: [
      { currency: "BRL", gross: 299.7, refunded: 99.9, net: 199.8, count: 3, refunds: 1 },
      { currency: "USD", gross: 24.95, refunded: 0, net: 24.95, count: 5, refunds: 0 },
    ],
  },
};

const RECENT = {
  events: [
    { ts: Date.now(), event: "subscribe", params: { content_id: "annual_pedagogy", value: 4.99 } },
  ],
};

const sandbox = {
  console,
  Intl,
  Date,
  Math,
  JSON,
  String,
  Number,
  document: {
    getElementById: el,
    querySelectorAll: () => [],
  },
  localStorage: { getItem: () => null, setItem: () => {} },
  confirm: () => false,
  alert: () => {},
  async fetch(url) {
    if (url.startsWith("/stats/overview")) {
      return { ok: true, status: 200, json: async () => OVERVIEW };
    }
    if (url.startsWith("/events")) {
      return { ok: true, status: 200, json: async () => RECENT };
    }
    if (url === "/health") {
      return { ok: true, status: 200, json: async () => ({ driver: "postgres" }) };
    }
    throw new Error("URL não prevista no teste: " + url);
  },
};
sandbox.window = sandbox;

vm.createContext(sandbox);
vm.runInContext(script, sandbox, { filename: "dashboard.js" });

// load() é async; espera o microtask drenar.
setTimeout(() => {
  let falhou = false;

  const msg = els["msg"];
  if (msg && msg.className.includes("err")) {
    console.log("❌ ERRO NA TELA:", msg.textContent);
    falhou = true;
  }

  for (const id of ["funnel", "subs", "kpis", "revenue", "countries", "events", "recent"]) {
    const node = els[id];
    const conteudo = (node && node.innerHTML) || "";
    const vazio = conteudo.trim().length === 0;
    const travado = conteudo.includes("Carregando");
    console.log(
      `${vazio || travado ? "❌" : "✅"} #${id.padEnd(10)} ${
        vazio ? "VAZIO" : travado ? "TRAVADO EM CARREGANDO" : conteudo.replace(/\s+/g, " ").slice(0, 92) + "…"
      }`,
    );
    if (vazio || travado) falhou = true;
  }

  console.log("\n" + (falhou ? "RESULTADO: FALHOU" : "RESULTADO: TODAS AS SEÇÕES RENDERIZARAM"));
  process.exit(falhou ? 1 : 0);
}, 300);
