// Tipos e contrato comum aos drivers de armazenamento (SQLite e Postgres).

export interface EventInput {
  event: string;
  params: Record<string, unknown>;
  ts: number; // timestamp do cliente (ms)
  receivedAt: number; // timestamp de recebimento no servidor (ms)
  /** ISO 3166-1 alpha-2 resolvido no ingest (header do edge). Nunca o IP. */
  country: string | null;
}

export interface StoredEvent {
  id: number;
  event: string;
  params: Record<string, unknown>;
  ts: number;
  received_at: number;
  product_id: string | null;
  currency: string | null;
  value: number | null;
  source: string | null;
  country: string | null;
}

export interface FunnelResult {
  from: number;
  to: number;
  stages: {
    paywall_view: number;
    checkout_initiated: number;
    converted: number; // subscribe + start_trial
  };
  rates: {
    viewToCheckout: number; // %
    checkoutToConvert: number; // %
    viewToConvert: number; // %
  };
}

export interface EventCount {
  event: string;
  count: number;
}

export interface RevenueRow {
  currency: string;
  /**
   * Receita REALIZADA no período: subscribe + purchase (legado).
   * Trials não entram — ver REVENUE_EVENTS em lib/events.ts.
   */
  total: number;
  /** Nº de compras pagas. */
  count: number;
  /** Nº de trials iniciados. Fecham o funil, mas não são receita. */
  trials: number;
  /** Quanto os trials somariam SE todos renovassem. É teto, não previsão. */
  trialValue: number;
}

export interface CountryRow {
  /** ISO 3166-1 alpha-2, ou null quando o edge não resolveu. */
  code: string | null;
  /** Emoji da bandeira (🏳️ quando desconhecido). */
  flag: string;
  /** Nome localizado em pt-BR ("Brasil"), ou "Desconhecido". */
  name: string;
  /** Total de eventos do país no período. */
  events: number;
  paywall_views: number;
  /** subscribe + start_trial */
  converted: number;
  /** converted / paywall_views, em % */
  rate: number;
}

export interface Store {
  driver: "sqlite" | "postgres";
  init(): Promise<void>;
  insert(events: EventInput[]): Promise<number>;
  funnel(from: number, to: number): Promise<FunnelResult>;
  eventCounts(from: number, to: number): Promise<EventCount[]>;
  revenue(from: number, to: number): Promise<RevenueRow[]>;
  countries(from: number, to: number): Promise<CountryRow[]>;
  recent(limit: number, offset: number): Promise<StoredEvent[]>;
  /** Apaga TODOS os eventos e zera o contador de id. Retorna quantos apagou. */
  clear(): Promise<number>;
  close(): Promise<void>;
}
