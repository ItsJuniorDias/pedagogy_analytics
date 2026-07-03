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

// Driver SQLite usando o módulo EMBUTIDO do Node (node:sqlite, Node >= 22.5).
// Sem dependência nativa, sem node-gyp, sem prebuild — nada pra compilar.
// Ideal pra rodar/testar local. Em produção use Postgres (defina DATABASE_URL);
// nesse caso este driver nem é carregado.
export function createSqliteStore(): Store {
  let DatabaseSync: new (path: string) => SqliteDb;
  try {
    // require preguiçoso: só carrega quando este driver é realmente usado.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    throw new Error(
      "SQLite local requer Node >= 22.5 (módulo node:sqlite). " +
        "Em produção/Render, defina DATABASE_URL para usar Postgres.",
    );
  }

  mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = new DatabaseSync(config.dbPath);
  db.exec("PRAGMA journal_mode = WAL");

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
      if (events.length === 0) return 0;
      const stmt = db.prepare(
        `INSERT INTO events
           (event, params, ts, received_at, product_id, currency, value, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      db.exec("BEGIN");
      try {
        for (const e of events) {
          const c = extractColumns(e.params);
          stmt.run(
            e.event,
            JSON.stringify(e.params ?? {}),
            e.ts,
            e.receivedAt,
            c.product_id,
            c.currency,
            c.value,
            c.source,
          );
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
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
        .all(from, to) as Array<{ event: string; c: number }>;
      const counts: Record<string, number> = {};
      for (const r of rows) counts[r.event] = Number(r.c);
      return buildFunnel(from, to, counts);
    },

    async eventCounts(from, to) {
      const rows = db
        .prepare(
          `SELECT event, COUNT(*) AS count FROM events
           WHERE ts >= ? AND ts <= ?
           GROUP BY event ORDER BY count DESC`,
        )
        .all(from, to) as Array<{ event: string; count: number }>;
      return rows.map((r) => ({ event: r.event, count: Number(r.count) })) as EventCount[];
    },

    async revenue(from, to) {
      const rows = db
        .prepare(
          `SELECT currency, SUM(value) AS total, COUNT(*) AS count FROM events
           WHERE event = 'purchase' AND ts >= ? AND ts <= ?
             AND value IS NOT NULL AND currency IS NOT NULL
           GROUP BY currency ORDER BY total DESC`,
        )
        .all(from, to) as Array<{ currency: string; total: number; count: number }>;
      return rows.map((r) => ({
        currency: r.currency,
        total: Number(r.total),
        count: Number(r.count),
      })) as RevenueRow[];
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

// Tipagem mínima do node:sqlite (evita depender de @types específico).
interface SqliteStmt {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number };
  all(...params: unknown[]): unknown[];
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStmt;
  close(): void;
}
