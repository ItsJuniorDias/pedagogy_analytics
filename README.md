# Pedagogy Analytics

Backend **first-party** para receber os eventos do app Pedagogy (o alvo do
`ANALYTICS_ENDPOINT`) e mostrar o **funil pré-compra** que o RevenueCat não
enxerga: `paywall_view → checkout_initiated → subscribe`.

Fastify + TypeScript. Roda em Node 20+. **SQLite** por padrão (zero-config) e
**Postgres** automático quando há `DATABASE_URL` (recomendado no Render).
Sem SDK de terceiro, sem IDFA — compatível com a categoria Kids.

---

## Rodar local em 30 segundos

> Requer **Node ≥ 22.5** (usa o módulo embutido `node:sqlite` — nada pra compilar).

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
| `DELETE` | `/admin/clear?confirm=DELETE_ALL` | admin | Apaga TODOS os eventos (irreversível). |

Rotas `/stats/*` e `GET /events` aceitam `?from=` e `?to=` (epoch ms **ou** ISO).
Default: últimos 7 dias. Auth admin via header `Authorization: Bearer <ADMIN_TOKEN>`.

**Limpar o banco** (ex.: apagar os dados de `seed` antes de ir pra produção):
pelo dashboard, botão *🗑 Limpar todos os eventos*; ou via curl —

```bash
curl -X DELETE "https://SEU-SERVICO/admin/clear?confirm=DELETE_ALL" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## Deploy no Render

**Opção A — Blueprint (1 clique, com Postgres):** o repo já tem `render.yaml`.
No Render: *New + → Blueprint →* aponte pro repositório. Ele cria o web service
+ um Postgres grátis, liga o `DATABASE_URL` sozinho e gera o `ADMIN_TOKEN`
(veja em *Environment*).

**Opção B — Web Service manual (corrigir um serviço existente):**
- **Language/Runtime:** Node
- **Build Command:** `npm install && npm run build`
- **Start Command:** `npm start`
- **Health check path:** `/health`
- **Environment:** `NODE_ENV=production`, `ADMIN_TOKEN=<forte>`, e o `DATABASE_URL`
  de um Postgres do Render (Internal Connection String).

O arquivo `.node-version` (22.11.0) fixa o Node numa LTS — sem isso o Render pega
a última (ex.: Node 26), que quebra libs.

> ⚠️ **Persistência no Render:** o filesystem é efêmero. Em produção use
> **Postgres** (basta setar `DATABASE_URL` — o app troca de driver sozinho); com
> SQLite sem disco montado, os eventos somem a cada deploy.

### Troubleshooting: `Build failed · exited with status 127`

Sintoma nos logs: `No prebuilt binaries found` + `node-gyp: command not found`
+ `install script from "better-sqlite3" exited with 127`.

Causa: uma dependência nativa tentando compilar num Node muito novo, sem
`node-gyp` no ambiente. **Este projeto não usa mais dependência nativa** (o
driver SQLite é o `node:sqlite` embutido), então:
1. Confirme que o **Build Command** está `npm install && npm run build`
   (não `bun install` puro — o Bun não roda o `tsc` e não traz `node-gyp`).
2. Garanta que o `.node-version` está no repo (fixa Node 22).
3. Em produção, defina `DATABASE_URL` (Postgres) — o SQLite nem é carregado lá.

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
    sqlite.ts        # driver SQLite (node:sqlite embutido, sem dep nativa)
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
