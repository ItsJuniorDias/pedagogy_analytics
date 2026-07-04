import type { Store } from "./db/types";
import type { MetaCapi } from "./lib/metaCapi";

declare module "fastify" {
  interface FastifyInstance {
    store: Store;
    metaCapi: MetaCapi;
  }
}
