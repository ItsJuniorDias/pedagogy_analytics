import { Pool } from "pg";

import { config } from "../config";
import { buildCountryRows } from "../lib/country";
import {
  APPLE_REFUND_EVENTS,
  APPLE_REVENUE_EVENTS,
  CONVERSION_EVENTS,
  EVENT,
  FUNNEL_EVENTS,
  MONETARY_EVENTS,
  REVENUE_EVENTS,
  SUB_EVENTS,
  TRIAL_EVENTS,
  sqlList,
} from "../lib/events";
import { extractColumns } from "../lib/extract";
import { buildFunnel } from "../lib/funnel";
import { buildSubscriptionStats } from "../lib/subStats";
import type {
  AppleRevenueRow,
  CountryRow,
  EventCount,
  EventInput,
  RevenueRow,
  Store,
  StoredEvent,
  SubscriptionPatch,
  SubscriptionRow,
} from "./types";

// Driver Postgres (pg, JS puro). Recomendado em produção/Render — persistente e
// sem build nativo. Ativado automaticamente quando DATABASE_URL está definido.
export function createPostgresStore(): Store {
  const url = config.databaseUrl as string;
  const pool = new Pool({
    connectionString: url,
    // Render/managed Postgres exige SSL; em local costuma não usar.
    ssl: needsSsl(url) ? { rejectUnauthorized: false } : undefined,
  });

  return {
    driver: "postgres",

    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS events (
          id          BIGSERIAL PRIMARY KEY,
          event       TEXT NOT NULL,
          params      JSONB NOT NULL DEFAULT '{}'::jsonb,
          ts          BIGINT NOT NULL,
          received_at BIGINT NOT NULL,
          product_id  TEXT,
          currency    TEXT,
          value       DOUBLE PRECISION,
          source      TEXT,
          country     TEXT
        );
      `);
      // Migração p/ bancos que já existiam antes da coluna de país.
      // Os eventos antigos ficam com country NULL e aparecem como
      // "Desconhecido" no relatório — o que é a verdade, e não zero.
      await pool.query(
        `ALTER TABLE events ADD COLUMN IF NOT EXISTS country TEXT;`,
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_events_event ON events(event);`,
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);`,
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_events_country ON events(country);`,
      );

      // ── Assinaturas (estado, alimentado pelo webhook da Apple) ───────────
      await pool.query(`
        CREATE TABLE IF NOT EXISTS subscriptions (
          sub_key           TEXT PRIMARY KEY,
          product_id        TEXT,
          status            TEXT NOT NULL DEFAULT 'active',
          is_trial          BOOLEAN NOT NULL DEFAULT FALSE,
          auto_renew        BOOLEAN NOT NULL DEFAULT TRUE,
          environment       TEXT,
          country           TEXT,
          currency          TEXT,
          price             DOUBLE PRECISION,
          started_at        BIGINT,
          expires_at        BIGINT,
          cancelled_at      BIGINT,
          expired_at        BIGINT,
          renewals          INTEGER NOT NULL DEFAULT 0,
          last_notification TEXT,
          updated_at        BIGINT NOT NULL
        );
      `);
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_subs_status ON subscriptions(status);`,
      );

      // ── Trava de idempotência das notificações da Apple ──────────────────
      // A Apple reenvia (até 5 vezes, ao longo de dias) quando não recebe 2xx.
      // A PK no uuid é o que impede um blip no Render de virar cancelamento
      // duplicado no relatório.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS apple_notifications (
          uuid              TEXT PRIMARY KEY,
          notification_type TEXT,
          subtype           TEXT,
          received_at       BIGINT NOT NULL
        );
      `);
    },

    async claimAppleNotification(uuid, type, subtype, receivedAt) {
      const { rowCount } = await pool.query(
        `INSERT INTO apple_notifications (uuid, notification_type, subtype, received_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (uuid) DO NOTHING`,
        [uuid, type, subtype, receivedAt],
      );
      return (rowCount ?? 0) > 0;
    },

    async getSubscription(subKey) {
      const { rows } = await pool.query(
        `SELECT * FROM subscriptions WHERE sub_key = $1`,
        [subKey],
      );
      const r = rows[0];
      if (!r) return null;
      return {
        ...r,
        price: r.price == null ? null : Number(r.price),
        started_at: num(r.started_at),
        expires_at: num(r.expires_at),
        cancelled_at: num(r.cancelled_at),
        expired_at: num(r.expired_at),
        renewals: Number(r.renewals ?? 0),
        updated_at: Number(r.updated_at),
      } as SubscriptionRow;
    },

    async upsertSubscription(p: SubscriptionPatch) {
      // COALESCE(EXCLUDED.x, subscriptions.x): campo ausente na notificação
      // NÃO apaga o que já sabíamos. Uma notificação de cancelamento não traz
      // o preço; sem o COALESCE, cancelar zeraria a receita da assinatura.
      await pool.query(
        `INSERT INTO subscriptions
           (sub_key, product_id, status, is_trial, auto_renew, environment,
            country, currency, price, started_at, expires_at, cancelled_at,
            expired_at, renewals, last_notification, updated_at)
         VALUES ($1,$2,COALESCE($3,'active'),COALESCE($4,FALSE),COALESCE($5,TRUE),
                 $6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (sub_key) DO UPDATE SET
           product_id        = COALESCE(EXCLUDED.product_id, subscriptions.product_id),
           status            = COALESCE(EXCLUDED.status, subscriptions.status),
           is_trial          = COALESCE($4, subscriptions.is_trial),
           auto_renew        = COALESCE($5, subscriptions.auto_renew),
           environment       = COALESCE(EXCLUDED.environment, subscriptions.environment),
           country           = COALESCE(EXCLUDED.country, subscriptions.country),
           currency          = COALESCE(EXCLUDED.currency, subscriptions.currency),
           price             = COALESCE(EXCLUDED.price, subscriptions.price),
           started_at        = COALESCE(EXCLUDED.started_at, subscriptions.started_at),
           expires_at        = COALESCE(EXCLUDED.expires_at, subscriptions.expires_at),
           cancelled_at      = COALESCE(EXCLUDED.cancelled_at, subscriptions.cancelled_at),
           expired_at        = COALESCE(EXCLUDED.expired_at, subscriptions.expired_at),
           renewals          = subscriptions.renewals + $14,
           last_notification = COALESCE(EXCLUDED.last_notification, subscriptions.last_notification),
           updated_at        = EXCLUDED.updated_at`,
        [
          p.sub_key,
          p.product_id ?? null,
          p.status ?? null,
          p.is_trial ?? null,
          p.auto_renew ?? null,
          p.environment ?? null,
          p.country ?? null,
          p.currency ?? null,
          p.price ?? null,
          p.started_at ?? null,
          p.expires_at ?? null,
          p.cancelled_at ?? null,
          p.expired_at ?? null,
          p.renewalsInc ?? 0,
          p.last_notification ?? null,
          p.updated_at,
        ],
      );
    },

    async subscriptionStats(from, to) {
      const now = Date.now();
      const [snap, counts, rev] = await Promise.all([
        pool.query(
          // `cancelPending` é a janela de win-back: cancelou, mas o acesso
          // ainda não acabou. Depois do expires_at não adianta mais oferecer
          // nada — a assinatura já morreu.
          `SELECT
             SUM(CASE WHEN status = 'active'        THEN 1 ELSE 0 END)::int AS active,
             SUM(CASE WHEN status = 'trialing'      THEN 1 ELSE 0 END)::int AS trialing,
             SUM(CASE WHEN status = 'cancelled'
                       AND (expires_at IS NULL OR expires_at > $1)
                                                    THEN 1 ELSE 0 END)::int AS cancel_pending,
             SUM(CASE WHEN status = 'billing_retry' THEN 1 ELSE 0 END)::int AS billing_retry,
             SUM(CASE WHEN status = 'expired'       THEN 1 ELSE 0 END)::int AS expired
           FROM subscriptions`,
          [now],
        ),
        pool.query(
          `SELECT event, COUNT(*)::int AS c FROM events
           WHERE ts >= $1 AND ts <= $2 AND event IN (${sqlList(SUB_EVENTS)})
           GROUP BY event`,
          [from, to],
        ),
        pool.query(
          `SELECT currency,
                  SUM(CASE WHEN event IN (${sqlList(APPLE_REVENUE_EVENTS)}) THEN value ELSE 0 END) AS gross,
                  SUM(CASE WHEN event IN (${sqlList(APPLE_REFUND_EVENTS)})  THEN value ELSE 0 END) AS refunded,
                  SUM(CASE WHEN event IN (${sqlList(APPLE_REVENUE_EVENTS)}) THEN 1 ELSE 0 END)::int AS count,
                  SUM(CASE WHEN event IN (${sqlList(APPLE_REFUND_EVENTS)})  THEN 1 ELSE 0 END)::int AS refunds
           FROM events
           WHERE ts >= $1 AND ts <= $2
             AND event IN (${sqlList([...APPLE_REVENUE_EVENTS, ...APPLE_REFUND_EVENTS])})
             AND value IS NOT NULL AND currency IS NOT NULL
           GROUP BY currency`,
          [from, to],
        ),
      ]);

      const s = snap.rows[0] ?? {};
      const counted: Record<string, number> = {};
      for (const r of counts.rows) counted[r.event] = Number(r.c);

      return buildSubscriptionStats(
        from,
        to,
        {
          active: Number(s.active ?? 0),
          trialing: Number(s.trialing ?? 0),
          cancelPending: Number(s.cancel_pending ?? 0),
          billingRetry: Number(s.billing_retry ?? 0),
          expired: Number(s.expired ?? 0),
        },
        counted,
        rev.rows.map((r) => {
          const gross = Number(r.gross ?? 0);
          const refunded = Number(r.refunded ?? 0);
          return {
            currency: r.currency as string,
            gross,
            refunded,
            net: gross - refunded,
            count: Number(r.count),
            refunds: Number(r.refunds),
          } as AppleRevenueRow;
        }),
      );
    },

    async insert(events: EventInput[]) {
      if (events.length === 0) return 0;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const e of events) {
          const c = extractColumns(e.params);
          await client.query(
            `INSERT INTO events
               (event, params, ts, received_at, product_id, currency, value, source, country)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              e.event,
              JSON.stringify(e.params ?? {}),
              e.ts,
              e.receivedAt,
              c.product_id,
              c.currency,
              c.value,
              c.source,
              e.country,
            ],
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
      return events.length;
    },

    async funnel(from, to) {
      const { rows } = await pool.query(
        `SELECT event, COUNT(*)::int AS c FROM events
         WHERE ts >= $1 AND ts <= $2
           AND event IN (${sqlList(FUNNEL_EVENTS)})
         GROUP BY event`,
        [from, to],
      );
      const counts: Record<string, number> = {};
      for (const r of rows) counts[r.event] = Number(r.c);
      return buildFunnel(from, to, counts);
    },

    async eventCounts(from, to) {
      const { rows } = await pool.query(
        `SELECT event, COUNT(*)::int AS count FROM events
         WHERE ts >= $1 AND ts <= $2
         GROUP BY event ORDER BY count DESC`,
        [from, to],
      );
      return rows.map((r) => ({
        event: r.event as string,
        count: Number(r.count),
      })) as EventCount[];
    },

    async revenue(from, to) {
      // Antes: `WHERE event = 'purchase'` — nome que o app nunca emitiu, então
      // a receita era sempre zero. Agora soma os eventos de REVENUE_EVENTS e
      // conta os trials numa coluna separada, sem misturar os dois.
      const { rows } = await pool.query(
        `SELECT currency,
                SUM(CASE WHEN event IN (${sqlList(REVENUE_EVENTS)}) THEN value ELSE 0 END) AS total,
                SUM(CASE WHEN event IN (${sqlList(REVENUE_EVENTS)}) THEN 1 ELSE 0 END)::int AS count,
                SUM(CASE WHEN event IN (${sqlList(TRIAL_EVENTS)}) THEN 1 ELSE 0 END)::int AS trials,
                SUM(CASE WHEN event IN (${sqlList(TRIAL_EVENTS)}) THEN value ELSE 0 END) AS trial_value
         FROM events
         WHERE ts >= $1 AND ts <= $2
           AND event IN (${sqlList(MONETARY_EVENTS)})
           AND value IS NOT NULL AND currency IS NOT NULL
         GROUP BY currency ORDER BY total DESC`,
        [from, to],
      );
      return rows.map((r) => ({
        currency: r.currency as string,
        total: Number(r.total ?? 0),
        count: Number(r.count),
        trials: Number(r.trials),
        trialValue: Number(r.trial_value ?? 0),
      })) as RevenueRow[];
    },

    async countries(from, to): Promise<CountryRow[]> {
      // SUM(CASE) em vez de COUNT(*) FILTER: o SQL fica idêntico ao do driver
      // SQLite, então os dois relatórios não podem divergir por dialeto.
      const { rows } = await pool.query(
        `SELECT country,
                COUNT(*)::int AS events,
                SUM(CASE WHEN event = '${EVENT.paywallView}' THEN 1 ELSE 0 END)::int AS paywall_views,
                SUM(CASE WHEN event IN (${sqlList(CONVERSION_EVENTS)}) THEN 1 ELSE 0 END)::int AS converted
         FROM events
         WHERE ts >= $1 AND ts <= $2
         GROUP BY country`,
        [from, to],
      );
      return buildCountryRows(
        rows.map((r) => ({
          country: (r.country as string | null) ?? null,
          events: Number(r.events),
          paywall_views: Number(r.paywall_views),
          converted: Number(r.converted),
        })),
      );
    },

    async recent(limit, offset) {
      const { rows } = await pool.query(
        `SELECT * FROM events ORDER BY id DESC LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      return rows.map((r) => ({
        ...r,
        ts: Number(r.ts),
        received_at: Number(r.received_at),
        value: r.value == null ? null : Number(r.value),
      })) as StoredEvent[];
    },

    async clear() {
      const { rows } = await pool.query("SELECT COUNT(*)::int AS c FROM events");
      const n = Number(rows[0]?.c ?? 0);
      // TRUNCATE é rápido e RESTART IDENTITY zera o contador do id.
      await pool.query("TRUNCATE TABLE events RESTART IDENTITY");
      // O estado das assinaturas e a trava de idempotência vão junto: deixar
      // `subscriptions` cheia com `events` vazia produz um dashboard que diz
      // "40 assinantes ativos, 0 assinaturas no período" — e ninguém consegue
      // decidir nada com isso.
      await pool.query("TRUNCATE TABLE subscriptions");
      await pool.query("TRUNCATE TABLE apple_notifications");
      return n;
    },

    async close() {
      await pool.end();
    },
  };
}

function num(v: unknown): number | null {
  return v == null ? null : Number(v);
}

function needsSsl(url: string): boolean {
  return /render\.com|amazonaws\.com|sslmode=require/.test(url);
}
