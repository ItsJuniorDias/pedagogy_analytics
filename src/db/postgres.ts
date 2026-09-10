import { Pool } from "pg";

import { config } from "../config";
import { buildCountryRows } from "../lib/country";
import {
  CONVERSION_EVENTS,
  EVENT,
  FUNNEL_EVENTS,
  MONETARY_EVENTS,
  REVENUE_EVENTS,
  TRIAL_EVENTS,
  sqlList,
} from "../lib/events";
import { extractColumns } from "../lib/extract";
import { buildFunnel } from "../lib/funnel";
import type {
  CountryRow,
  EventCount,
  EventInput,
  RevenueRow,
  Store,
  StoredEvent,
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
      return n;
    },

    async close() {
      await pool.end();
    },
  };
}

function needsSsl(url: string): boolean {
  return /render\.com|amazonaws\.com|sslmode=require/.test(url);
}
