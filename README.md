# Pedagogy Analytics

Backend **first-party** para receber os eventos do app Pedagogy (o alvo do
`ANALYTICS_ENDPOINT`) e mostrar o **funil pré-compra** que o RevenueCat não
enxerga: `paywall_view → checkout_initiated → subscribe`.

Fastify + TypeScript. Roda em Node 20+. **SQLite** por padrão (zero-config) e
**Postgres** automático quando há `DATABASE_URL` (recomendado no Render).
Sem SDK de terceiro, sem IDFA — compatível com a categoria Kids.

---

## Rodar local em 30 segundos

```bash
npm install
npm run seed     # popula ~14 dias de eventos de exemplo (opcional)
npm run dev      # sobe em http://localhost:3000
```

Abra **http://localhost:3000** — é o dashboard. Em dev, sem `ADMIN_TOKEN`
definido, ele já abre liberado.

Testando o ingest na mão:

```bash
curl -X POST http://localhost:3000/events \
  -H "Content-Type: application/json" \
  -d '{"event":"paywall_view","params":{"source":"reader"},"ts":'$(date +%s000)'}'
```

Rodar em modo produção local:

```bash
npm run build && npm start
```

---

## Conectar o app

No app (`lib/analytics.ts`), aponte o endpoint para este serviço:

```ts
const ANALYTICS_ENDPOINT = "https://SEU-SERVICO.onrender.com/events";
```

Pronto — os eventos passam a chegar. O app já envia o formato certo:

```json
{ "event": "checkout_initiated",
  "params": { "content_id": "annual", "value": 99.9, "currency": "BRL" },
  "ts": 1719950000000 }
```

> Se você ligar `INGEST_TOKEN` no servidor, adicione o header `x-api-key` com o
> mesmo valor dentro de `sendFirstParty()` no app.

---

## Endpoints

| Método | Rota | Auth | O que faz |
|---|---|---|---|
| `POST` | `/events` | opcional (`INGEST_TOKEN`) | Ingesta 1 evento **ou** um array (até 50). |
| `GET`  | `/health` | pública | Status + driver do banco (Render usa). |
| `GET`  | `/` | pública | Dashboard (dados vêm dos `/stats/*` com token). |
| `GET`  | `/stats/overview` | admin | Funil + eventos + receita de uma vez. |
| `GET`  | `/stats/funnel` | admin | Só o funil e as taxas. |
| `GET`  | `/stats/events` | admin | Contagem por evento. |
| `GET`  | `/stats/revenue` | admin | Soma de `purchase` por moeda. |
| `GET`  | `/events` | admin | Eventos crus (debug), paginado. |

Rotas `/stats/*` e `GET /events` aceitam `?from=` e `?to=` (epoch ms **ou** ISO).
Default: últimos 7 dias. Auth admin via header `Authorization: Bearer <ADMIN_TOKEN>`.

---

## Deploy no Render

**Opção A — Blueprint (1 clique, com Postgres):** o repo já tem `render.yaml`.
No Render: *New + → Blueprint →* aponte pro repositório. Ele cria o web service
+ um Postgres grátis, liga o `DATABASE_URL` sozinho e gera o `ADMIN_TOKEN`
(veja em *Environment*).

**Opção B — Web Service manual:**
- Build: `npm install && npm run build`
- Start: `npm start`
- Health check path: `/health`
- Env: `NODE_ENV=production`, `ADMIN_TOKEN=<forte>`, e o `DATABASE_URL` do seu
  Postgres do Render.

> ⚠️ **Persistência no Render:** o filesystem é efêmero. Se usar **SQLite** sem
> um disco montado, os eventos somem a cada deploy. Em produção use **Postgres**
> (basta setar `DATABASE_URL` — o app troca de driver sozinho) ou monte um disco
> e aponte `DB_PATH` pra ele.

---

## Configuração (env)

Copie `.env.example` para `.env`. Principais:

| Var | Default | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta (Render injeta). |
| `ADMIN_TOKEN` | — | Protege `/stats/*` e `GET /events`. **Obrigatório em prod.** |
| `INGEST_TOKEN` | vazio | Se setado, exige `x-api-key` no `/events`. |
| `DATABASE_URL` | vazio | Se preenchido → Postgres; senão → SQLite. |
| `DB_PATH` | `./data/analytics.db` | Arquivo SQLite (quando sem Postgres). |
| `RATE_LIMIT_PER_MIN` | `300` | Limite por IP no `/events` (0 = off). |
| `CORS_ORIGIN` | `*` | Origem liberada no `/events` (Expo web). |

Sem `ADMIN_TOKEN`: liberado em dev, **bloqueado em produção** (fail-safe).

---

## O que dá (e o que não dá) pra medir

Os eventos são **sem PII** (nada de id de usuário/device, nada de IDFA). Isso é
ótimo pra compliance Kids, mas significa que o funil é uma razão de **volume de
eventos**, não conversão por usuário — sinal direcional, perfeito pra saber
**onde está a maior queda**. Combine com o RevenueCat (que mede o funil de
assinatura por usuário) e você tem o quadro completo.

**Upgrade opcional:** se um dia você gerar um `anon_id` aleatório no device
(random UUID guardado local — **não** é IDFA) e mandar em `params`, dá pra
evoluir as queries pra funil por sessão sem mudar a arquitetura.

---

## Estrutura

```
src/
  server.ts          # Fastify: registra rotas, sobe o servidor
  config.ts          # env
  db/
    index.ts         # escolhe o driver (Postgres se DATABASE_URL, senão SQLite)
    types.ts         # contrato Store + tipos
    sqlite.ts        # driver SQLite (better-sqlite3, opcional/lazy)
    postgres.ts      # driver Postgres (pg)
  routes/
    ingest.ts        # POST /events
    stats.ts         # GET /stats/* e GET /events
    health.ts        # GET /health
  lib/
    funnel.ts        # monta o funil a partir das contagens
    extract.ts       # extrai product_id/currency/value/source do params
    auth.ts          # guard do ADMIN_TOKEN
    ratelimit.ts     # limiter em memória por IP
public/index.html    # dashboard
scripts/seed.ts      # dados de exemplo
render.yaml          # blueprint de deploy
```
