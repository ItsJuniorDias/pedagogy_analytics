// Tipos e contrato comum aos drivers de armazenamento (SQLite e Postgres).

export interface EventInput {
  event: string;
  params: Record<string, unknown>;
  ts: number; // timestamp do cliente (ms)
  receivedAt: number; // timestamp de recebimento no servidor (ms)
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
  total: number;
  count: number;
}

export interface Store {
  driver: "sqlite" | "postgres";
  init(): Promise<void>;
  insert(events: EventInput[]): Promise<number>;
  funnel(from: number, to: number): Promise<FunnelResult>;
  eventCounts(from: number, to: number): Promise<EventCount[]>;
  revenue(from: number, to: number): Promise<RevenueRow[]>;
  recent(limit: number, offset: number): Promise<StoredEvent[]>;
  close(): Promise<void>;
}
