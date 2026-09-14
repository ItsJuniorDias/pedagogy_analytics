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

/**
 * `StoredEvent` + país já formatado. É o que `GET /events` devolve.
 *
 * A formatação é do SERVIDOR, igual ao que `/stats/countries` já faz. O
 * dashboard é um HTML solto, sem build — ele não consegue importar
 * `lib/country.ts`. Montar a bandeira no cliente significaria uma segunda
 * cópia da aritmética de Regional Indicator, e duas implementações da mesma
 * regra divergem na primeira vez que alguém corrigir só uma delas.
 */
export interface StoredEventView extends StoredEvent {
  /** Emoji da bandeira (🏳️ quando `country` é null). */
  flag: string;
  /** Nome localizado em pt-BR ("Brasil"), ou "Desconhecido". */
  country_name: string;
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

// ─── ASSINATURAS (estado vindo da Apple) ────────────────────────────────────
//
// Por que uma tabela separada em vez de mais linhas em `events`:
//
//   `events` é um fluxo append-only e SEM identidade — é o que mantém o funil
//   compatível com a categoria Kids. Assinatura é o oposto: uma entidade com
//   ESTADO que muda ao longo de meses (trial → pago → cancelado → expirado).
//   Só com estado dá pra responder "quantos assinantes ativos existem agora?"
//   e "esse cancelamento foi de um trial ou de um pagante?" — a notificação da
//   Apple, sozinha, não diz nenhuma das duas coisas.
//
// A chave é `sub_key`: HMAC-SHA256 do `originalTransactionId`. O id cru da
// Apple nunca é gravado. Pra investigar um caso específico, gere o HMAC do id
// que o cliente te passar e procure por ele.
// ────────────────────────────────────────────────────────────────────────────

export interface SubscriptionRow {
  /** HMAC do originalTransactionId. Nunca o id cru. */
  sub_key: string;
  product_id: string | null;
  /** active | trialing | cancelled | expired | billing_retry | refunded | revoked */
  status: string;
  is_trial: boolean;
  /** false = a pessoa desligou a renovação (mas talvez ainda tenha acesso). */
  auto_renew: boolean;
  environment: string | null;
  /** ISO alpha-2 do storefront (onde ela PAGA). */
  country: string | null;
  currency: string | null;
  /** Em unidade monetária, já dividido por 1000. */
  price: number | null;
  started_at: number | null;
  expires_at: number | null;
  cancelled_at: number | null;
  expired_at: number | null;
  renewals: number;
  last_notification: string | null;
  updated_at: number;
}

/** Campos `undefined` são preservados; a linha nunca é sobrescrita inteira. */
export interface SubscriptionPatch {
  sub_key: string;
  product_id?: string | null;
  status?: string;
  is_trial?: boolean;
  auto_renew?: boolean;
  environment?: string | null;
  country?: string | null;
  currency?: string | null;
  price?: number | null;
  started_at?: number | null;
  expires_at?: number | null;
  cancelled_at?: number | null;
  expired_at?: number | null;
  /** Quanto somar em `renewals` (0 na maioria das notificações). */
  renewalsInc?: number;
  last_notification?: string | null;
  updated_at: number;
}

export interface AppleRevenueRow {
  currency: string;
  /** Confirmado pela Apple: assinaturas + renovações. */
  gross: number;
  /** Reembolsado no período (valor positivo). */
  refunded: number;
  /** gross − refunded. */
  net: number;
  /** Nº de cobranças confirmadas. */
  count: number;
  /** Nº de reembolsos. */
  refunds: number;
}

export interface SubscriptionStats {
  from: number;
  to: number;
  /** Foto de AGORA — não depende do período escolhido. */
  now: {
    active: number;
    trialing: number;
    /** Cancelou mas ainda tem acesso. É aqui que win-back ainda funciona. */
    cancelPending: number;
    billingRetry: number;
    expired: number;
  };
  /** Contagens DENTRO do período (da tabela de eventos). */
  period: Record<string, number>;
  rates: {
    /** trials cancelados ÷ trials iniciados, no período. */
    trialCancel: number;
    /** convertidos ÷ (convertidos + expirados) — só trials que já terminaram. */
    trialConversion: number;
    /** cancelamentos ÷ novas assinaturas, no período. */
    cancel: number;
  };
  revenue: AppleRevenueRow[];
}

export interface Store {
  driver: "sqlite" | "postgres";
  init(): Promise<void>;
  insert(events: EventInput[]): Promise<number>;
  /**
   * Registra o UUID da notificação. Devolve `true` se era inédita.
   *
   * A Apple REENVIA a mesma notificação quando o seu servidor não responde
   * 2xx (e às vezes mesmo quando responde). Sem esta trava, uma instabilidade
   * de 30s no Render vira cinco cancelamentos no dashboard.
   */
  claimAppleNotification(
    uuid: string,
    type: string,
    subtype: string | null,
    receivedAt: number,
  ): Promise<boolean>;
  getSubscription(subKey: string): Promise<SubscriptionRow | null>;
  upsertSubscription(patch: SubscriptionPatch): Promise<void>;
  subscriptionStats(from: number, to: number): Promise<SubscriptionStats>;
  funnel(from: number, to: number): Promise<FunnelResult>;
  eventCounts(from: number, to: number): Promise<EventCount[]>;
  revenue(from: number, to: number): Promise<RevenueRow[]>;
  countries(from: number, to: number): Promise<CountryRow[]>;
  recent(limit: number, offset: number): Promise<StoredEvent[]>;
  /** Apaga TODOS os eventos e zera o contador de id. Retorna quantos apagou. */
  clear(): Promise<number>;
  close(): Promise<void>;
}
