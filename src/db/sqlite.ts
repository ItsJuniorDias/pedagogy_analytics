import { mkdirSync } from "fs";
import { dirname } from "path";

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

// Driver SQLite (better-sqlite3). Zero-config: grava num arquivo local.
// Ideal pra rodar/testar na hora; em produção prefira Postgres (ver README).
export function createSqliteStore(): Store {
  // require preguiçoso: só carrega o módulo nativo quando este driver é usado,
  // então um deploy só-Postgres não depende do build do better-sqlite3.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require("better-sqlite3");

  mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");

  return {
    driver: "sqlite",

    async init() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          event       TEXT    NOT NULL,
          params      TEXT    NOT NULL DEFAULT '{}',
          ts          INTEGER NOT NULL,
          received_at INTEGER NOT NULL,
          product_id  TEXT,
          currency    TEXT,
          value       REAL,
          source      TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_events_event ON events(event);
        CREATE INDEX IF NOT EXISTS idx_events_ts    ON events(ts);
      `);
    },

    async insert(events: EventInput[]) {
      const stmt = db.prepare(
        `INSERT INTO events
           (event, params, ts, received_at, product_id, currency, value, source)
         VALUES
           (@event, @params, @ts, @received_at, @product_id, @currency, @value, @source)`,
      );
      const tx = db.transaction((rows: EventInput[]) => {
        for (const e of rows) {
          const c = extractColumns(e.params);
          stmt.run({
            event: e.event,
            params: JSON.stringify(e.params ?? {}),
            ts: e.ts,
            received_at: e.receivedAt,
            product_id: c.product_id,
            currency: c.currency,
            value: c.value,
            source: c.source,
          });
        }
      });
      tx(events);
      return events.length;
    },

    async funnel(from, to) {
      const rows = db
        .prepare(
          `SELECT event, COUNT(*) AS c FROM events
           WHERE ts >= ? AND ts <= ?
             AND event IN ('paywall_view','checkout_initiated','subscribe','start_trial')
           GROUP BY event`,
        )
        .all(from, to) as { event: string; c: number }[];
      const counts: Record<string, number> = {};
      for (const r of rows) counts[r.event] = r.c;
      return buildFunnel(from, to, counts);
    },

    async eventCounts(from, to) {
      return db
        .prepare(
          `SELECT event, COUNT(*) AS count FROM events
           WHERE ts >= ? AND ts <= ?
           GROUP BY event ORDER BY count DESC`,
        )
        .all(from, to) as EventCount[];
    },

    async revenue(from, to) {
      return db
        .prepare(
          `SELECT currency, SUM(value) AS total, COUNT(*) AS count FROM events
           WHERE event = 'purchase' AND ts >= ? AND ts <= ?
             AND value IS NOT NULL AND currency IS NOT NULL
           GROUP BY currency ORDER BY total DESC`,
        )
        .all(from, to) as RevenueRow[];
    },

    async recent(limit, offset) {
      const rows = db
        .prepare(`SELECT * FROM events ORDER BY id DESC LIMIT ? OFFSET ?`)
        .all(limit, offset) as Array<
        Omit<StoredEvent, "params"> & { params: string }
      >;
      return rows.map((r) => ({ ...r, params: safeParse(r.params) }));
    },

    async close() {
      db.close();
    },
  };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
