// ─── CERTIFICADOS RAIZ DA APPLE ─────────────────────────────────────────────
//
// A Apple assina cada notificação como JWS e põe a cadeia de certificados no
// header `x5c`. Verificar a assinatura sem checar essa cadeia contra a raiz da
// Apple não prova nada: qualquer um pode gerar um JWS bem formado e mandar pro
// seu endpoint. Sem raiz, o webhook vira um formulário aberto onde o
// concorrente (ou um bot) escreve "3.000 cancelamentos" no seu dashboard.
//
// Por isso os `.cer` NÃO vêm no repo por padrão: são binários públicos da
// Apple, baixados por `npm run certs:apple`. Se a pasta estiver vazia o
// servidor sobe, avisa alto no log e o webhook responde 503 — nunca 200 pra
// dado que não foi verificado.
//
// Alternativa pra quem não quer arquivo no repo: APPLE_ROOT_CERTS_B64 com os
// certificados em base64 separados por vírgula (cabe numa env var do Render).
// ────────────────────────────────────────────────────────────────────────────

import { readdirSync, readFileSync } from "fs";
import { isAbsolute, join } from "path";

import { config } from "../config";

/** Converte um PEM (-----BEGIN CERTIFICATE-----) no DER que a lib espera. */
function pemToDer(pem: string): Buffer {
  const b64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  return Buffer.from(b64, "base64");
}

/** `.cer` da Apple vem em DER binário, mas alguns mirrors servem PEM. */
function normalize(buf: Buffer): Buffer {
  const head = buf.subarray(0, 32).toString("ascii");
  return head.includes("BEGIN CERTIFICATE") ? pemToDer(buf.toString("ascii")) : buf;
}

function fromEnv(): Buffer[] {
  if (!config.appleRootCertsB64) return [];
  return config.appleRootCertsB64
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => normalize(Buffer.from(s, "base64")));
}

function fromDir(): Buffer[] {
  const dir = isAbsolute(config.appleRootCertsDir)
    ? config.appleRootCertsDir
    : join(process.cwd(), config.appleRootCertsDir);

  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => /\.(cer|pem|crt|der)$/i.test(n));
  } catch {
    return []; // pasta não existe — trata igual a pasta vazia
  }

  return names.map((n) => normalize(readFileSync(join(dir, n))));
}

let cache: Buffer[] | null = null;

/**
 * Raízes DER pra passar no `SignedDataVerifier`. Env tem prioridade sobre a
 * pasta. Lista vazia = webhook desligado (quem chama decide o que fazer).
 */
export function loadAppleRootCertificates(): Buffer[] {
  if (cache) return cache;
  const certs = fromEnv();
  cache = certs.length > 0 ? certs : fromDir();
  return cache;
}

/** Só pra teste — força reler do disco na próxima chamada. */
export function resetAppleRootCertificatesCache(): void {
  cache = null;
}
