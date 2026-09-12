import { mkdirSync } from "fs";
import { dirname } from "path";

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
          source      TEXT,
          country     TEXT
        );
      `);

      // Migração p/ bancos criados antes da coluna de país. O SQLite não tem
      // `ADD COLUMN IF NOT EXISTS`, então perguntamos ao PRAGMA primeiro.
      const cols = db.prepare(`PRAGMA table_info(events)`).all() as Array<{
        name: string;
      }>;
      if (!cols.some((c) => c.name === "country")) {
        db.exec(`ALTER TABLE events ADD COLUMN country TEXT`);
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_events_event   ON events(event);
        CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(ts);
        CREATE INDEX IF NOT EXISTS idx_events_country ON events(country);
      `);

      // ── Assinaturas + idempotência (mesmo schema do Postgres) ────────────
      // Booleano vira INTEGER 0/1: o SQLite não tem BOOLEAN de verdade.
      db.exec(`
        CREATE TABLE IF NOT EXISTS subscriptions (
          sub_key           TEXT PRIMARY KEY,
          product_id        TEXT,
          status            TEXT    NOT NULL DEFAULT 'active',
          is_trial          INTEGER NOT NULL DEFAULT 0,
          auto_renew        INTEGER NOT NULL DEFAULT 1,
          environment       TEXT,
          country           TEXT,
          currency          TEXT,
          price             REAL,
          started_at        INTEGER,
          expires_at        INTEGER,
          cancelled_at      INTEGER,
          expired_at        INTEGER,
          renewals          INTEGER NOT NULL DEFAULT 0,
          last_notification TEXT,
          updated_at        INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_subs_status ON subscriptions(status);

        CREATE TABLE IF NOT EXISTS apple_notifications (
          uuid              TEXT PRIMARY KEY,
          notification_type TEXT,
          subtype           TEXT,
          received_at       INTEGER NOT NULL
        );
      `);
    },

    async claimAppleNotification(uuid, type, subtype, receivedAt) {
      const res = db
        .prepare(
          `INSERT INTO apple_notifications (uuid, notification_type, subtype, received_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(uuid) DO NOTHING`,
        )
        .run(uuid, type, subtype, receivedAt);
      return Number(res.changes) > 0;
    },

    async getSubscription(subKey) {
      const rows = db
        .prepare(`SELECT * FROM subscriptions WHERE sub_key = ?`)
        .all(subKey) as Array<Record<string, unknown>>;
      const r = rows[0];
      if (!r) return null;
      return {
        ...r,
        is_trial: Number(r.is_trial) === 1,
        auto_renew: Number(r.auto_renew) === 1,
        renewals: Number(r.renewals ?? 0),
        updated_at: Number(r.updated_at),
      } as unknown as SubscriptionRow;
    },

    async upsertSubscription(p: SubscriptionPatch) {
      // COALESCE(?, subscriptions.x) em todo campo: a notificação de
      // cancelamento não traz preço nem produto, e sobrescrever com NULL
      // apagaria o que já sabíamos da assinatura.
      db.prepare(
        `INSERT INTO subscriptions
           (sub_key, product_id, status, is_trial, auto_renew, environment,
            country, currency, price, started_at, expires_at, cancelled_at,
            expired_at, renewals, last_notification, updated_at)
         VALUES (?, ?, COALESCE(?,'active'), COALESCE(?,0), COALESCE(?,1),
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sub_key) DO UPDATE SET
           product_id        = COALESCE(excluded.product_id, subscriptions.product_id),
           status            = COALESCE(excluded.status, subscriptions.status),
           is_trial          = COALESCE(?, subscriptions.is_trial),
           auto_renew        = COALESCE(?, subscriptions.auto_renew),
           environment       = COALESCE(excluded.environment, subscriptions.environment),
           country           = COALESCE(excluded.country, subscriptions.country),
           currency          = COALESCE(excluded.currency, subscriptions.currency),
           price             = COALESCE(excluded.price, subscriptions.price),
           started_at        = COALESCE(excluded.started_at, subscriptions.started_at),
           expires_at        = COALESCE(excluded.expires_at, subscriptions.expires_at),
           cancelled_at      = COALESCE(excluded.cancelled_at, subscriptions.cancelled_at),
           expired_at        = COALESCE(excluded.expired_at, subscriptions.expired_at),
           renewals          = subscriptions.renewals + ?,
           last_notification = COALESCE(excluded.last_notification, subscriptions.last_notification),
           updated_at        = excluded.updated_at`,
      ).run(
        p.sub_key,
        p.product_id ?? null,
        p.status ?? null,
        bool(p.is_trial),
        bool(p.auto_renew),
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
        // repetidos pro bloco do UPDATE (o node:sqlite não reusa placeholder)
        bool(p.is_trial),
        bool(p.auto_renew),
        p.renewalsInc ?? 0,
      );
    },

    async subscriptionStats(from, to) {
      const nowMs = Date.now();
      const snap = (
        db
          .prepare(
            `SELECT
               SUM(CASE WHEN status = 'active'        THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN status = 'trialing'      THEN 1 ELSE 0 END) AS trialing,
               SUM(CASE WHEN status = 'cancelled'
                         AND (expires_at IS NULL OR expires_at > ?)
                                                      THEN 1 ELSE 0 END) AS cancel_pending,
               SUM(CASE WHEN status = 'billing_retry' THEN 1 ELSE 0 END) AS billing_retry,
               SUM(CASE WHEN status = 'expired'       THEN 1 ELSE 0 END) AS expired
             FROM subscriptions`,
          )
          .all(nowMs) as Array<Record<string, number>>
      )[0] ?? {};

      const counts = db
        .prepare(
          `SELECT event, COUNT(*) AS c FROM events
           WHERE ts >= ? AND ts <= ? AND event IN (${sqlList(SUB_EVENTS)})
           GROUP BY event`,
        )
        .all(from, to) as Array<{ event: string; c: number }>;

      const rev = db
        .prepare(
          `SELECT currency,
                  SUM(CASE WHEN event IN (${sqlList(APPLE_REVENUE_EVENTS)}) THEN value ELSE 0 END) AS gross,
                  SUM(CASE WHEN event IN (${sqlList(APPLE_REFUND_EVENTS)})  THEN value ELSE 0 END) AS refunded,
                  SUM(CASE WHEN event IN (${sqlList(APPLE_REVENUE_EVENTS)}) THEN 1 ELSE 0 END) AS count,
                  SUM(CASE WHEN event IN (${sqlList(APPLE_REFUND_EVENTS)})  THEN 1 ELSE 0 END) AS refunds
           FROM events
           WHERE ts >= ? AND ts <= ?
             AND event IN (${sqlList([...APPLE_REVENUE_EVENTS, ...APPLE_REFUND_EVENTS])})
             AND value IS NOT NULL AND currency IS NOT NULL
           GROUP BY currency`,
        )
        .all(from, to) as Array<{
        currency: string;
        gross: number;
        refunded: number;
        count: number;
        refunds: number;
      }>;

      const counted: Record<string, number> = {};
      for (const r of counts) counted[r.event] = Number(r.c);

      return buildSubscriptionStats(
        from,
        to,
        {
          active: Number(snap.active ?? 0),
          trialing: Number(snap.trialing ?? 0),
          cancelPending: Number(snap.cancel_pending ?? 0),
          billingRetry: Number(snap.billing_retry ?? 0),
          expired: Number(snap.expired ?? 0),
        },
        counted,
        rev.map((r) => {
          const gross = Number(r.gross ?? 0);
          const refunded = Number(r.refunded ?? 0);
          return {
            currency: r.currency,
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
      const stmt = db.prepare(
        `INSERT INTO events
           (event, params, ts, received_at, product_id, currency, value, source, country)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            e.country,
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
             AND event IN (${sqlList(FUNNEL_EVENTS)})
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
      // Antes: `WHERE event = 'purchase'` — nome que o app nunca emitiu, então
      // a receita era sempre zero. Mesma query do driver Postgres, de propósito.
      const rows = db
        .prepare(
          `SELECT currency,
                  SUM(CASE WHEN event IN (${sqlList(REVENUE_EVENTS)}) THEN value ELSE 0 END) AS total,
                  SUM(CASE WHEN event IN (${sqlList(REVENUE_EVENTS)}) THEN 1 ELSE 0 END) AS count,
                  SUM(CASE WHEN event IN (${sqlList(TRIAL_EVENTS)}) THEN 1 ELSE 0 END) AS trials,
                  SUM(CASE WHEN event IN (${sqlList(TRIAL_EVENTS)}) THEN value ELSE 0 END) AS trial_value
           FROM events
           WHERE ts >= ? AND ts <= ?
             AND event IN (${sqlList(MONETARY_EVENTS)})
             AND value IS NOT NULL AND currency IS NOT NULL
           GROUP BY currency ORDER BY total DESC`,
        )
        .all(from, to) as Array<{
        currency: string;
        total: number;
        count: number;
        trials: number;
        trial_value: number;
      }>;
      return rows.map((r) => ({
        currency: r.currency,
        total: Number(r.total ?? 0),
        count: Number(r.count),
        trials: Number(r.trials),
        trialValue: Number(r.trial_value ?? 0),
      })) as RevenueRow[];
    },

    async countries(from, to): Promise<CountryRow[]> {
      const rows = db
        .prepare(
          `SELECT country,
                  COUNT(*) AS events,
                  SUM(CASE WHEN event = '${EVENT.paywallView}' THEN 1 ELSE 0 END) AS paywall_views,
                  SUM(CASE WHEN event IN (${sqlList(CONVERSION_EVENTS)}) THEN 1 ELSE 0 END) AS converted
           FROM events
           WHERE ts >= ? AND ts <= ?
           GROUP BY country`,
        )
        .all(from, to) as Array<{
        country: string | null;
        events: number;
        paywall_views: number;
        converted: number;
      }>;
      return buildCountryRows(
        rows.map((r) => ({
          country: r.country ?? null,
          events: Number(r.events),
          paywall_views: Number(r.paywall_views),
          converted: Number(r.converted),
        })),
      );
    },

    async recent(limit, offset) {
      const rows = db
        .prepare(`SELECT * FROM events ORDER BY id DESC LIMIT ? OFFSET ?`)
        .all(limit, offset) as Array<
        Omit<StoredEvent, "params"> & { params: string }
      >;
      return rows.map((r) => ({ ...r, params: safeParse(r.params) }));
    },

    async clear() {
      const rows = db
        .prepare("SELECT COUNT(*) AS c FROM events")
        .all() as Array<{ c: number }>;
      const n = Number(rows[0]?.c ?? 0);
      db.exec("DELETE FROM events");
      // Estado de assinatura junto: `subscriptions` cheia com `events` vazia
      // produziria "40 ativos, 0 assinaturas no período" — número que não
      // permite decidir nada.
      db.exec("DELETE FROM subscriptions");
      db.exec("DELETE FROM apple_notifications");
      try {
        // zera o contador do AUTOINCREMENT (id volta a começar em 1)
        db.exec("DELETE FROM sqlite_sequence WHERE name = 'events'");
      } catch {
        /* sqlite_sequence pode não existir ainda; ignora */
      }
      return n;
    },

    async close() {
      db.close();
    },
  };
}

/** O SQLite não tem boolean: true→1, false→0, undefined→null (= não mexe). */
function bool(v: boolean | undefined): number | null {
  return v === undefined ? null : v ? 1 : 0;
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
