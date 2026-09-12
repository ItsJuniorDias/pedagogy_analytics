// ─── STOREFRONT DA APPLE (alpha-3) → ISO alpha-2 ────────────────────────────
//
// A Apple manda o país da loja como TRÊS letras ("BRA", "USA") em
// `storefront`, mas o resto do sistema (lib/country.ts, coluna `country`,
// bandeira por code point) fala DUAS letras. Sem conversão, todo evento vindo
// do webhook cairia em 🏳️ Desconhecido — justamente os eventos onde o país
// importa mais, porque storefront é onde a pessoa PAGA.
//
// A tabela abaixo é o ISO 3166-1 inteiro (249 entradas), não uma lista curada
// dos países "que interessam": país novo no ISO é raro, e uma lista parcial
// erra em silêncio. Fica como uma string de trincas+duplas (ABW→AW, AFG→AF…)
// e vira Map na primeira chamada — ~1,2 KB de fonte, zero dependência.
// ────────────────────────────────────────────────────────────────────────────

const ALPHA3_ALPHA2 =
  "ABWAWAFGAFAGOAOAIAAIALAAXALBALANDADAREAEARGARARMAMASMASATAAQATFTFATGAGAUSAUAUTATAZEAZBDIBIBELBEBENBJ" +
  "BESBQBFABFBGDBDBGRBGBHRBHBHSBSBIHBABLMBLBLRBYBLZBZBMUBMBOLBOBRABRBRBBBBRNBNBTNBTBVTBVBWABWCAFCFCANCA" +
  "CCKCCCHECHCHLCLCHNCNCIVCICMRCMCODCDCOGCGCOKCKCOLCOCOMKMCPVCVCRICRCUBCUCUWCWCXRCXCYMKYCYPCYCZECZDEUDE" +
  "DJIDJDMADMDNKDKDOMDODZADZECUECEGYEGERIERESHEHESPESESTEEETHETFINFIFJIFJFLKFKFRAFRFROFOFSMFMGABGAGBRGB" +
  "GEOGEGGYGGGHAGHGIBGIGINGNGLPGPGMBGMGNBGWGNQGQGRCGRGRDGDGRLGLGTMGTGUFGFGUMGUGUYGYHKGHKHMDHMHNDHNHRVHR" +
  "HTIHTHUNHUIDNIDIMNIMINDINIOTIOIRLIEIRNIRIRQIQISLISISRILITAITJAMJMJEYJEJORJOJPNJPKAZKZKENKEKGZKGKHMKH" +
  "KIRKIKNAKNKORKRKWTKWLAOLALBNLBLBRLRLBYLYLCALCLIELILKALKLSOLSLTULTLUXLULVALVMACMOMAFMFMARMAMCOMCMDAMD" +
  "MDGMGMDVMVMEXMXMHLMHMKDMKMLIMLMLTMTMMRMMMNEMEMNGMNMNPMPMOZMZMRTMRMSRMSMTQMQMUSMUMWIMWMYSMYMYTYTNAMNA" +
  "NCLNCNERNENFKNFNGANGNICNINIUNUNLDNLNORNONPLNPNRUNRNZLNZOMNOMPAKPKPANPAPCNPNPERPEPHLPHPLWPWPNGPGPOLPL" +
  "PRIPRPRKKPPRTPTPRYPYPSEPSPYFPFQATQAREUREROURORUSRURWARWSAUSASDNSDSENSNSGPSGSGSGSSHNSHSJMSJSLBSBSLESL" +
  "SLVSVSMRSMSOMSOSPMPMSRBRSSSDSSSTPSTSURSRSVKSKSVNSISWESESWZSZSXMSXSYCSCSYRSYTCATCTCDTDTGOTGTHATHTJKTJ" +
  "TKLTKTKMTMTLSTLTONTOTTOTTTUNTNTURTRTUVTVTWNTWTZATZUGAUGUKRUAUMIUMURYUYUSAUSUZBUZVATVAVCTVCVENVEVGBVG" +
  "VIRVIVNMVNVUTVUWLFWFWSMWSYEMYEZAFZAZMBZMZWEZW";

let table: Map<string, string> | null = null;

function lookup(): Map<string, string> {
  if (!table) {
    table = new Map();
    for (let i = 0; i < ALPHA3_ALPHA2.length; i += 5) {
      table.set(ALPHA3_ALPHA2.slice(i, i + 3), ALPHA3_ALPHA2.slice(i + 3, i + 5));
    }
  }
  return table;
}

/**
 * "BRA" → "BR". Devolve null pra qualquer coisa que não seja um alpha-3 do
 * ISO 3166-1 — incluindo os pseudo-storefronts que a Apple usa em sandbox.
 *
 * Aceita alpha-2 de volta sem mexer, pra poder chamar sem checar a origem.
 */
export function storefrontToAlpha2(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(code)) return code;
  if (!/^[A-Z]{3}$/.test(code)) return null;
  return lookup().get(code) ?? null;
}
