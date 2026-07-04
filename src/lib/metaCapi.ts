// Meta Conversions API (CAPI) — endpoint web/dataset (Graph API v25.0).
//
// Kids Category: NÃO usamos o CAPI for App Events (exige o SDK do Meta dentro do
// app, o que derruba na Guideline 1.3). Usamos o endpoint web/dataset apontando
// pro pixel, e os eventos in-app entram como `system_generated`, casados por
// fbc/fbp/e-mail do responsável (SHA-256).
//
// Sem dependências externas: usa fetch global (Node >= 22.5) e node:crypto.

import crypto from "node:crypto";

// ----------------------------------------------------------------------------
// Tipos
// ----------------------------------------------------------------------------
export type MetaActionSource =
  | "website"
  | "system_generated" // evento de backend/CRM — é o que usamos p/ eventos in-app
  | "physical_store"
  | "chat"
  | "phone_call"
  | "email"
  | "other";

export interface MetaUserData {
  email?: string | null; // e-mail do RESPONSÁVEL (COPPA-safe) — hasheado
  phone?: string | null; // com DDI, só dígitos — hasheado
  firstName?: string | null;
  lastName?: string | null;
  externalId?: string | null; // id interno/anon do app — hasheado
  fbc?: string | null; // cookie _fbc ou construído do fbclid — NÃO hashear
  fbp?: string | null; // cookie _fbp — NÃO hashear
  clientIpAddress?: string | null; // NÃO hashear
  clientUserAgent?: string | null; // NÃO hashear
  country?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

export interface MetaCustomData {
  value?: number;
  currency?: string;
  contentName?: string;
  contentType?: string;
  contentIds?: string[];
  numItems?: number;
  [key: string]: unknown;
}

export interface MetaEventInput {
  eventName: string; // 'Purchase' | 'ViewContent' | 'InitiateCheckout' | 'StartTrial' | custom
  eventId: string; // STRING. Mesmo id do pixel quando for dedup.
  eventTime?: number; // unix seconds; default = agora. Máx 7 dias atrás.
  actionSource: MetaActionSource;
  eventSourceUrl?: string | null; // obrigatório p/ action_source 'website'
  userData: MetaUserData;
  customData?: MetaCustomData;
}

export interface CapiLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface MetaCapiConfig {
  datasetId: string; // = ID do pixel
  accessToken: string; // System User token com ads_management
  apiVersion?: string; // default 'v25.0'
  testEventCode?: string | null; // p/ aba "Eventos de teste"
  maxRetries?: number; // default 3
  enabled?: boolean; // se false, send() vira no-op
  logger?: CapiLogger;
}

export interface MetaCapiResult {
  ok: boolean;
  response?: unknown;
  error?: unknown;
  skipped?: boolean;
}

// ----------------------------------------------------------------------------
// Normalização + hashing (regras exatas do Meta)
// ----------------------------------------------------------------------------
const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest("hex");

const normEmail = (v: string) => v.trim().toLowerCase();
const normName = (v: string) => v.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
const normPhone = (v: string) => v.replace(/[^0-9]/g, ""); // manter DDI, sem + nem espaços
const normLoose = (v: string) => v.trim().toLowerCase().replace(/\s+/g, "");

function hashIf(
  value: string | null | undefined,
  normalize: (s: string) => string,
): string | undefined {
  if (!value) return undefined;
  const n = normalize(value);
  return n ? sha256(n) : undefined;
}

function buildUserData(u: MetaUserData): Record<string, unknown> {
  const ud: Record<string, unknown> = {};

  const em = hashIf(u.email, normEmail);
  const ph = hashIf(u.phone, normPhone);
  const fn = hashIf(u.firstName, normName);
  const ln = hashIf(u.lastName, normName);
  const country = hashIf(u.country, normLoose);
  const ct = hashIf(u.city, normLoose);
  const st = hashIf(u.state, normLoose);
  const zp = hashIf(u.zip, normLoose);

  if (em) ud.em = em;
  if (ph) ud.ph = ph;
  if (fn) ud.fn = fn;
  if (ln) ud.ln = ln;
  if (country) ud.country = country;
  if (ct) ud.ct = ct;
  if (st) ud.st = st;
  if (zp) ud.zp = zp;
  if (u.externalId) ud.external_id = sha256(u.externalId.trim().toLowerCase());

  // NÃO hasheados (mandar crus):
  if (u.fbc) ud.fbc = u.fbc;
  if (u.fbp) ud.fbp = u.fbp;
  if (u.clientIpAddress) ud.client_ip_address = u.clientIpAddress;
  if (u.clientUserAgent) ud.client_user_agent = u.clientUserAgent;

  return ud;
}

function buildCustomData(
  c?: MetaCustomData,
): Record<string, unknown> | undefined {
  if (!c) return undefined;
  const { contentName, contentType, contentIds, numItems, ...rest } = c;
  const cd: Record<string, unknown> = { ...rest };
  if (contentName !== undefined) cd.content_name = contentName;
  if (contentType !== undefined) cd.content_type = contentType;
  if (contentIds !== undefined) cd.content_ids = contentIds;
  if (numItems !== undefined) cd.num_items = numItems;
  return cd;
}

// ----------------------------------------------------------------------------
// Cliente
// ----------------------------------------------------------------------------
export class MetaCapi {
  private datasetId: string;
  private accessToken: string;
  private apiVersion: string;
  private testEventCode: string | null;
  private maxRetries: number;
  private enabled: boolean;
  private logger: CapiLogger;

  constructor(cfg: MetaCapiConfig) {
    this.datasetId = cfg.datasetId;
    this.accessToken = cfg.accessToken;
    this.apiVersion = cfg.apiVersion ?? "v25.0";
    this.testEventCode = cfg.testEventCode ?? null;
    this.maxRetries = cfg.maxRetries ?? 3;
    this.enabled = cfg.enabled ?? true;
    this.logger = cfg.logger ?? console;
  }

  private get endpoint(): string {
    return `https://graph.facebook.com/${this.apiVersion}/${this.datasetId}/events`;
  }

  /** Monta o objeto de evento no formato do Meta (útil p/ testar/logar). */
  buildEvent(input: MetaEventInput): Record<string, unknown> {
    const evt: Record<string, unknown> = {
      event_name: input.eventName,
      event_time: input.eventTime ?? Math.floor(Date.now() / 1000),
      event_id: input.eventId, // string!
      action_source: input.actionSource,
      user_data: buildUserData(input.userData),
    };
    if (input.eventSourceUrl) evt.event_source_url = input.eventSourceUrl;
    const cd = buildCustomData(input.customData);
    if (cd) evt.custom_data = cd;
    return evt;
  }

  /** Envia 1 evento. */
  send(input: MetaEventInput): Promise<MetaCapiResult> {
    return this.sendBatch([input]);
  }

  /** Envia N eventos em um POST. Retry em 429/5xx/erro de rede. */
  async sendBatch(inputs: MetaEventInput[]): Promise<MetaCapiResult> {
    if (!this.enabled)
      return { ok: false, skipped: true, error: "CAPI desativado (sem token)" };
    if (inputs.length === 0) return { ok: true, skipped: true };

    const body: Record<string, unknown> = {
      data: inputs.map((i) => this.buildEvent(i)),
      access_token: this.accessToken, // no body (não vaza na URL/logs)
    };
    if (this.testEventCode) body.test_event_code = this.testEventCode;

    let attempt = 0;
    let lastError: unknown;

    while (attempt <= this.maxRetries) {
      try {
        const res = await fetch(this.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json: any = await res.json().catch(() => ({}));

        if (res.ok) {
          this.logger.info(
            {
              events: inputs.length,
              fbtrace_id: json?.fbtrace_id,
              events_received: json?.events_received,
            },
            "[CAPI] enviado",
          );
          return { ok: true, response: json };
        }

        // 4xx (exceto 429) = erro de payload/permissão: retry não resolve.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          this.logger.error(
            { status: res.status, error: json?.error ?? json },
            "[CAPI] erro de payload",
          );
          return { ok: false, error: json };
        }

        lastError = json; // 429 ou 5xx → retry
      } catch (err) {
        lastError = err; // rede → retry
      }

      attempt++;
      if (attempt <= this.maxRetries) {
        const backoff = 300 * 2 ** (attempt - 1); // 300ms, 600ms, 1200ms
        await new Promise((r) => setTimeout(r, backoff));
      }
    }

    this.logger.error({ error: lastError }, "[CAPI] falhou após retries");
    return { ok: false, error: lastError };
  }
}
