// ─── PAÍS + BANDEIRA ────────────────────────────────────────────────────────
//
// O país vem do EDGE, não do device. Quem termina a conexão (Cloudflare, na
// frente do Render) já resolveu o IP em país e manda o resultado num header.
// Nós lemos esse header e guardamos DUAS LETRAS. O IP nunca é gravado.
//
// Por que não pedir pro app mandar:
//
//   1. O app já está em produção. Header funciona hoje, pra quem já instalou;
//      mudar o app só valeria da próxima versão em diante.
//   2. Categoria Kids. O app não coleta nada de localização, e continua não
//      coletando — a granularidade "país" é derivada da conexão, do lado do
//      servidor, e não é ligada a nenhum identificador (não existe user id
//      aqui).
//
// Mesmo assim `params.country` tem PRIORIDADE sobre o header. Se um dia você
// mandar `Storefront.current?.countryCode` do StoreKit, ele entra sozinho sem
// mexer em backend — e é um dado melhor pra receita, porque storefront é onde
// a pessoa PAGA, que nem sempre é de onde ela abre o app.
//
// A bandeira não precisa de tabela: emoji de bandeira é o par de Regional
// Indicator Symbols das letras do código ISO. "BR" → 🇧🇷 é aritmética.
// ────────────────────────────────────────────────────────────────────────────

import type { CountryRow } from "../db/types";

const LETTER_A = 0x41; // 'A'
const REGIONAL_INDICATOR_A = 0x1f1e6; // 🇦

/**
 * Aceita só ISO 3166-1 alpha-2. Devolve `null` pra qualquer outra coisa —
 * incluindo os dois valores que a Cloudflare usa e que NÃO são país:
 *
 *   XX → não foi possível determinar
 *   T1 → saindo pela rede Tor
 *
 * Guardar esses como se fossem país criaria uma "nação" fantasma no relatório.
 */
export function normalizeCountry(raw: unknown): string | null {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== "string") return null;

  const code = first.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  if (code === "XX" || code === "T1") return null;

  return code;
}

/**
 * Código ISO → emoji de bandeira. Sem código, devolve a bandeira branca (🏳️),
 * que é neutra e não se confunde com nenhum país real.
 */
export function flagEmoji(code: string | null): string {
  const c = normalizeCountry(code);
  if (!c) return "🏳️";

  return String.fromCodePoint(
    ...[...c].map((ch) => REGIONAL_INDICATOR_A + (ch.charCodeAt(0) - LETTER_A)),
  );
}

// `Intl.DisplayNames` é caro pra instanciar e o resultado é o mesmo sempre.
// Um por locale, criado na primeira vez que precisa.
const displayNamesCache = new Map<string, Intl.DisplayNames | null>();

function displayNamesFor(locale: string): Intl.DisplayNames | null {
  if (!displayNamesCache.has(locale)) {
    try {
      displayNamesCache.set(
        locale,
        new Intl.DisplayNames([locale], { type: "region" }),
      );
    } catch {
      // Node compilado sem ICU completo (small-icu) não tem os nomes de região.
      // Degrada pro próprio código — o dashboard continua legível.
      displayNamesCache.set(locale, null);
    }
  }
  return displayNamesCache.get(locale) ?? null;
}

/**
 * Nome do país no idioma pedido. "BR" → "Brasil". Se o ICU não tiver o nome
 * (ou o código for regional, tipo "EU"), devolve o próprio código.
 */
export function countryName(code: string | null, locale = "pt-BR"): string {
  const c = normalizeCountry(code);
  if (!c) return "Desconhecido";

  try {
    return displayNamesFor(locale)?.of(c) ?? c;
  } catch {
    return c;
  }
}

/** Linha crua que os drivers de banco devolvem (só contagem, sem formatação). */
export interface CountryAgg {
  country: string | null;
  events: number;
  paywall_views: number;
  converted: number;
}

/**
 * Enriquece a contagem crua com bandeira, nome e taxa de conversão.
 *
 * A taxa é `converted / paywall_views` — não sobre o total de eventos. Um país
 * onde as crianças leem muito e ninguém assina tem MUITO evento e taxa baixa;
 * misturar as duas coisas esconderia exatamente o que interessa.
 */
export function toCountryRow(agg: CountryAgg): CountryRow {
  const code = normalizeCountry(agg.country);
  const views = agg.paywall_views;

  return {
    code,
    flag: flagEmoji(code),
    name: countryName(code),
    events: agg.events,
    paywall_views: views,
    converted: agg.converted,
    rate: views > 0 ? Math.round((agg.converted / views) * 1000) / 10 : 0,
  };
}

/** Ordena por volume de paywall_view (e desempata por eventos totais). */
export function buildCountryRows(aggs: CountryAgg[]): CountryRow[] {
  return aggs
    .map(toCountryRow)
    .sort((a, b) => b.paywall_views - a.paywall_views || b.events - a.events);
}
