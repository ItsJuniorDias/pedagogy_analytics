// Extrai colunas indexáveis do params (o params completo é guardado como JSON).
// Aceita as duas convenções que o app usa (ex.: currency vs currencyCode).
export function extractColumns(params: Record<string, unknown>) {
  const product_id = str(params.content_id) ?? str(params.product_id);
  const currency = str(params.currency) ?? str(params.currencyCode);
  const rawValue = params.amount ?? params.value ?? params._value;
  const value =
    typeof rawValue === "number" && Number.isFinite(rawValue) ? rawValue : null;
  const source = str(params.source);
  return { product_id, currency, value, source };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
