// Popula o banco com ~14 dias de eventos simulados, pra testar o dashboard.
// Uso: npm run seed   (usa o mesmo DATABASE_URL/DB_PATH do servidor)
import { createStore } from "../src/db";
import type { EventInput } from "../src/db/types";

const DAY = 24 * 60 * 60 * 1000;

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
    for (let i = 0; i < subs; i++) {
      const t = jitter(base);
      events.push(
        ev("subscribe", { content_id: "annual", currency: "BRL", _value: 99.9 }, t),
      );
      events.push(
        ev(
          "purchase",
          { amount: 99.9, currencyCode: "BRL", product_id: "annual", is_subscription: true },
          t,
        ),
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
): EventInput {
  return { event, params, ts, receivedAt: Date.now() };
}

function jitter(base: number): number {
  return base + Math.floor(Math.random() * DAY);
}

void main();
