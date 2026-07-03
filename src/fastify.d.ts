import type { Store } from "./db/types";

declare module "fastify" {
  interface FastifyInstance {
    store: Store;
  }
}
