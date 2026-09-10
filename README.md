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
| `GET`  | `/stats/overview` | admin | Funil + eventos + receita + países de uma vez. |
| `GET`  | `/stats/funnel` | admin | Só o funil e as taxas. |
| `GET`  | `/stats/events` | admin | Contagem por evento. |
| `GET`  | `/stats/revenue` | admin | Receita paga por moeda + trials à parte. |
| `GET`  | `/stats/countries` | admin | Países com bandeira, volume e conversão. |
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

## Receita: por que trial não entra

A query de receita filtrava por `event = 'purchase'` — um nome que **nenhuma
parte do sistema emitia**. O app manda `subscribe`, o funil conta `subscribe`,
o Meta CAPI espelha `subscribe`. Resultado: o funil dizia "3 assinaturas" e o
card de receita dizia "R$ 0,00" ao mesmo tempo.

O conserto soma `subscribe` (+ `purchase`, mantido só para não apagar linhas de
bancos antigos). **`start_trial` ficou de fora de propósito.**

O motivo está no app: `PaywallView.swift:309` manda o **preço cheio** do produto
no `value` do trial, porque é isso que o Meta CAPI precisa para otimizar
campanha. Somar esse valor na receita contaria como pago um dinheiro que
ninguém pagou — e que boa parte nunca vai pagar, já que trial tem cancelamento.
Um trial vira receita quando renova, e a renovação chega como `subscribe`.

Por isso `/stats/revenue` devolve quatro campos por moeda:

| Campo | O que é |
|---|---|
| `total` | Receita realizada (`subscribe` + `purchase`). |
| `count` | Nº de assinaturas pagas. |
| `trials` | Nº de trials iniciados. Não entram em `total`. |
| `trialValue` | Quanto os trials somariam se **todos** renovassem. É teto, não previsão. |

Isso explica a diferença que você vai ver no dashboard: "Assinaturas + trials"
no funil é maior que "Compras" na receita. Os dois estão certos — o funil mede
quem chegou ao fim, a receita mede quem pagou.

**Nomes de evento agora vivem em `src/lib/events.ts`.** Os dois drivers importam
de lá em vez de repetir a string no SQL. O bug acima só passou despercebido
porque cada arquivo tinha a sua própria cópia de `'purchase'`.

⚠️ **Se você já rodou `npm run seed` contra o banco de produção**, ele gravava
`subscribe` *e* `purchase` para a mesma venda simulada — com a query nova isso
conta duas vezes. O `seed.ts` foi corrigido, mas as linhas antigas continuam lá:
limpe com o botão *🗑 Limpar todos os eventos* antes de olhar número pra valer.

---

## Países

O relatório de países sai de duas letras por evento — o IP **não** é lido, não é
logado e não é gravado em lugar nenhum.

**De onde vem.** A Cloudflare fica na frente do Render e resolve o IP em país
antes da requisição chegar aqui, entregando o resultado no header
`cf-ipcountry`. O `ingest.ts` lê esse header, valida que são duas letras ISO
3166-1 e guarda numa coluna `country`. `XX` (não determinado) e `T1` (Tor) são
descartados — não são países, e virariam nações fantasma no relatório.

**Nada muda no app.** Como a resolução é no servidor, isso funciona para quem
já tem o app instalado, sem submissão nova e sem esperar review. A postura de
privacidade também não muda: o app continua sem coletar localização, e a
granularidade "país" não está ligada a nenhum identificador — não existe user
id neste backend.

**Override pelo app (opcional, e melhor).** Se `params.country` vier no evento,
ele ganha do header. Isso já está implementado esperando o dia em que você
mandar o storefront do StoreKit:

```swift
// no PaywallView, junto dos outros params
"country": await Storefront.current?.countryCode ?? ""
```

A diferença importa: o header diz de onde a pessoa **abriu** o app; o storefront
diz onde ela **paga**. Um brasileiro morando em Lisboa aparece como 🇵🇹 pelo
header e 🇵🇹 ou 🇧🇷 pelo storefront, dependendo da conta Apple dele — e é o
storefront que determina em que moeda a venda entra.

**Bandeira sem tabela.** Emoji de bandeira é o par de Regional Indicator Symbols
das letras do código: `BR` → 🇧🇷 é aritmética sobre code points, não lookup. O
nome do país vem do `Intl.DisplayNames` em pt-BR ("Brasil", "Estados Unidos").
Zero dependência nova, zero lista pra manter.

**Eventos antigos.** A coluna é nova; tudo que já estava gravado tem
`country NULL` e aparece agrupado como 🏳️ Desconhecido. Isso é a verdade e não
zero — e o número vai encolhendo sozinho conforme os eventos novos chegam.

**Taxa com piso de amostra.** O dashboard mostra "—" em vez da porcentagem para
países com menos de 10 paywall views. Com 2 views e 1 assinatura, "50%" é ruído
que convida a decidir errado.

```bash
curl -s "https://SEU-SERVICO/stats/countries" \
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
    country.ts       # normaliza ISO, bandeira por code point, nome via Intl
    funnel.ts        # monta o funil a partir das contagens
    extract.ts       # extrai product_id/currency/value/source do params
    auth.ts          # guard do ADMIN_TOKEN
    ratelimit.ts     # limiter em memória por IP
public/index.html    # dashboard
scripts/seed.ts      # dados de exemplo
render.yaml          # blueprint de deploy
```
