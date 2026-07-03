import { config } from "../config";
import { createPostgresStore } from "./postgres";
import { createSqliteStore } from "./sqlite";
import type { Store } from "./types";

// Postgres quando houver DATABASE_URL; senão SQLite local.
export function createStore(): Store {
  return config.databaseUrl ? createPostgresStore() : createSqliteStore();
}

export type { Store } from "./types";
