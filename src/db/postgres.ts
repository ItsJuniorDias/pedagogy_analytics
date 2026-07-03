import { Pool } from "pg";

import { config } from "../config";
import { extractColumns } from "../lib/extract";
import { buildFunnel } from "../lib/funnel";
import type {
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
          source      TEXT
        );
      `);
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_events_event ON events(event);`,
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);`,
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
               (event, params, ts, received_at, product_id, currency, value, source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              e.event,
              JSON.stringify(e.params ?? {}),
              e.ts,
              e.receivedAt,
              c.product_id,
              c.currency,
              c.value,
              c.source,
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
           AND event IN ('paywall_view','checkout_initiated','subscribe','start_trial')
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
      const { rows } = await pool.query(
        `SELECT currency, SUM(value) AS total, COUNT(*)::int AS count FROM events
         WHERE event = 'purchase' AND ts >= $1 AND ts <= $2
           AND value IS NOT NULL AND currency IS NOT NULL
         GROUP BY currency ORDER BY total DESC`,
        [from, to],
      );
      return rows.map((r) => ({
        currency: r.currency as string,
        total: Number(r.total),
        count: Number(r.count),
      })) as RevenueRow[];
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
