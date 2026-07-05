# CAPI — o que mudou e como ligar

Integração do **Meta Conversions API** (Graph API **v25.0**, endpoint web/dataset)
no `pedagogy-analytics`. Sem dependências novas, sem mudança de schema no banco.

## Arquivos deste zip

| Arquivo | O quê |
|---|---|
| `src/lib/metaCapi.ts` | **novo** — serviço CAPI (hashing SHA-256, payload, envio c/ retry) |
| `src/lib/capiMirror.ts` | **novo** — mapeia evento do app → evento do Meta + extrai fbc/fbp/email do `params` |
| `src/config.ts` | +config `META_*` |
| `src/fastify.d.ts` | +`fastify.metaCapi` |
| `src/server.ts` | instancia e decora o `metaCapi` (mesmo padrão do `store`) |
| `src/routes/ingest.ts` | após gravar, espelha os eventos pro Meta (best-effort) |
| `render.yaml` | +env vars do CAPI |
| `.env.example` | **novo** — todas as variáveis documentadas |

Basta sobrepor estes arquivos no seu projeto (mantêm a estrutura de pastas).

## Como funciona

O app já manda `{ event, params, ts }` pro `/events`. Depois do `store.insert`,
o `/events` chama `mirrorEventsToMeta(...)` **sem `await`** (não bloqueia a resposta).
O mapa:

| Evento do app | Evento do Meta | value? |
|---|---|---|
| `paywall_view` | `ViewContent` | — |
| `checkout_initiated` | `InitiateCheckout` | — |
| `subscribe` | `Purchase` | sim (value + currency) |
| `start_trial` | `StartTrial` | — |

`action_source` = `system_generated` (correto p/ dataset web, sem SDK).

## Ligar (2 passos)

1. **Token:** Business Settings → Users → **System Users** → Generate token, escopo
   `ads_management`. Cole em `META_CAPI_TOKEN` (no `.env` local e no painel do Render —
   está como `sync: false` no blueprint). `META_DATASET_ID` já vem preenchido (`967920369353096`).
2. **Deploy.** Sem token, o CAPI fica em no-op e loga `"[CAPI] desativado"` — nada quebra.

## Testar

1. Pegue o código na aba **Eventos de teste** do Events Manager e ponha em `META_TEST_EVENT_CODE`.
2. Dispare um evento (ou use o app em TestFlight). Ele aparece na aba de teste em segundos,
   com o Event Match Quality de cada campo.
3. **Esvazie** `META_TEST_EVENT_CODE` p/ ir a produção.

## O gargalo que ainda falta (próximo changeset)

O `Purchase` só é **atribuído** à campanha se carregar `fbc`/`fbp` (ou e-mail do responsável)
que vieram do site. Hoje o código já lê esses campos do `params` — mas o **app precisa passá-los**.
Como o app é anônimo e o `fbclid` morre ao sair do Safari, a ponte real é:

1. capturar `{ email, fbc, fbp }` no site (com uma isca) e guardar;
2. capturar o **mesmo e-mail** no app (`$email` no RevenueCat);
3. no `subscribe`, enviar esse e-mail no `params` → o CAPI casa por e-mail hasheado.

Isso é o **próximo changeset** (tabela `leads` + rota `POST /lead` + lookup por e-mail no
`subscribe`). Validou que os eventos estão chegando no Events Manager? Aí a gente monta a ponte.

Campos que o app pode mandar no `params` (todos opcionais, mas melhoram o match):
`email`, `fbc`, `fbp`, `fbclid`, `external_id`/`app_user_id`, `value`, `currency`, `content_id`, `event_id`.
