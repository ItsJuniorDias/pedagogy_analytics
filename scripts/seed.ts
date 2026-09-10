// Popula o banco com ~14 dias de eventos simulados, pra testar o dashboard.
// Uso: npm run seed   (usa o mesmo DATABASE_URL/DB_PATH do servidor)
import { createStore } from "../src/db";
import type { EventInput } from "../src/db/types";

const DAY = 24 * 60 * 60 * 1000;

// Distribuição de países pro seed, com pesos plausíveis pra um app em inglês
// publicado no mundo todo. `null` simula o evento cujo país o edge não
// resolveu (VPN, proxy corporativo, header ausente) — ele existe de verdade em
// produção e o dashboard precisa saber desenhar isso.
const COUNTRIES: Array<[string | null, number]> = [
  ["US", 34],
  ["BR", 22],
  ["GB", 9],
  ["CA", 7],
  ["AU", 5],
  ["DE", 4],
  ["MX", 4],
  ["PT", 3],
  ["ES", 3],
  ["IN", 3],
  ["JP", 2],
  [null, 4],
];

const COUNTRY_WEIGHT_TOTAL = COUNTRIES.reduce((a, [, w]) => a + w, 0);

function pickCountry(): string | null {
  let n = Math.random() * COUNTRY_WEIGHT_TOTAL;
  for (const [code, weight] of COUNTRIES) {
    n -= weight;
    if (n <= 0) return code;
  }
  return null;
}

async function main() {
  const store = createStore();
  await store.init();

  const now = Date.now();
  const events: EventInput[] = [];

  for (let d = 13; d >= 0; d--) {
    const base = now - d * DAY;

    const views = 40 + Math.floor(Math.random() * 30);
    const checkouts = Math.floor(views * (0.25 + Math.random() * 0.15));
    const subs = Math.floor(checkouts * (0.35 + Math.random() * 0.2));

    for (let i = 0; i < views; i++) {
      events.push(ev("paywall_view", { source: "reader" }, jitter(base)));
    }
    for (let i = 0; i < checkouts; i++) {
      events.push(
        ev(
          "checkout_initiated",
          { content_id: "annual", value: 99.9, currency: "BRL" },
          jitter(base),
        ),
      );
    }
    // ⚠️ O seed antigo emitia `subscribe` E `purchase` pra cada venda, porque a
    // query de receita só olhava `purchase`. Agora que ela soma os dois, manter
    // o par DOBRARIA a receita simulada. Uma venda = um evento.
    for (let i = 0; i < subs; i++) {
      const t = jitter(base);
      events.push(
        ev("subscribe", { content_id: "annual", currency: "BRL", value: 99.9 }, t),
      );
    }

    // Trials: fecham o funil igual a uma assinatura, mas valem 0 hoje. O app
    // manda o preço cheio no `value` (é o que o Meta CAPI espera), então o
    // seed faz igual — é justamente isso que a query não pode somar na receita.
    const trials = Math.floor(subs * (0.3 + Math.random() * 0.3));
    for (let i = 0; i < trials; i++) {
      events.push(
        ev("start_trial", { content_id: "annual", currency: "BRL", value: 99.9 }, jitter(base)),
      );
    }
    // engajamento (não entra no funil, mas aparece nos "top eventos")
    for (let i = 0; i < views * 2; i++) {
      const storyId = "story_" + (1 + Math.floor(Math.random() * 50));
      events.push(ev("content_open", { content_id: storyId }, jitter(base)));
    }
    for (let i = 0; i < views; i++) {
      events.push(ev("tutorial_completed", { success: true }, jitter(base)));
    }
  }

  const n = await store.insert(events);
  // eslint-disable-next-line no-console
  console.log(`Seed OK: ${n} eventos inseridos (driver=${store.driver}).`);
  await store.close();
}

function ev(
  event: string,
  params: Record<string, unknown>,
  ts: number,
  country: string | null = pickCountry(),
): EventInput {
  return { event, params, ts, receivedAt: Date.now(), country };
}

function jitter(base: number): number {
  return base + Math.floor(Math.random() * DAY);
}

void main();
