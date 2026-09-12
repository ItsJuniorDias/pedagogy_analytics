// ─── VERIFICAÇÃO DAS NOTIFICAÇÕES DA APPLE ──────────────────────────────────
//
// Fininho em cima de `@apple/app-store-server-library` (a lib oficial, JS puro
// — nada de node-gyp, o que mantém o deploy do Render verde). Existe pra:
//
//   • carregar preguiçosamente: quem roda sem webhook não paga o custo;
//   • dizer POR QUE está desligado, em vez de estourar um erro genérico;
//   • ter um modo "decodifica sem verificar", explicitamente perigoso, pra
//     destravar teste local sem os .cer.
//
// O verifier confere a cadeia até a raiz da Apple E que bundleId/ambiente
// batem com os seus. Sem isso, o endpoint aceita qualquer JSON assinado por
// qualquer um.
// ────────────────────────────────────────────────────────────────────────────

import { config } from "../config";
import { loadAppleRootCertificates } from "./appleCerts";

/** Forma mínima do que a gente consome do payload decodificado. */
export interface DecodedNotification {
  notificationType?: string;
  subtype?: string;
  notificationUUID?: string;
  signedDate?: number;
  data?: {
    environment?: string;
    bundleId?: string;
    signedTransactionInfo?: string;
    signedRenewalInfo?: string;
    status?: number;
  };
}

export interface DecodedTransaction {
  originalTransactionId?: string;
  transactionId?: string;
  productId?: string;
  purchaseDate?: number;
  originalPurchaseDate?: number;
  expiresDate?: number;
  type?: string;
  offerType?: number;
  offerDiscountType?: string;
  environment?: string;
  storefront?: string;
  currency?: string;
  price?: number;
  revocationDate?: number;
  revocationReason?: number;
  transactionReason?: string;
}

export interface DecodedRenewalInfo {
  originalTransactionId?: string;
  autoRenewStatus?: number;
  autoRenewProductId?: string;
  expirationIntent?: number;
  isInBillingRetryPeriod?: boolean;
  gracePeriodExpiresDate?: number;
  renewalDate?: number;
  currency?: string;
  renewalPrice?: number;
  offerDiscountType?: string;
  recentSubscriptionStartDate?: number;
}

export interface AppleVerifier {
  enabled: boolean;
  /** Motivo de estar desligado — vai pro log no boot e pro corpo do 503. */
  reason: string | null;
  verifying: boolean;
  verifyNotification(signedPayload: string): Promise<DecodedNotification>;
  verifyTransaction(jws: string): Promise<DecodedTransaction>;
  verifyRenewalInfo(jws: string): Promise<DecodedRenewalInfo>;
}

/** Decodifica o corpo de um JWS SEM checar assinatura. Só pro modo inseguro. */
function decodeUnsafe<T>(jws: string): T {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new Error("JWS malformado");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as T;
}

function disabled(reason: string): AppleVerifier {
  const fail = async (): Promise<never> => {
    throw new Error(reason);
  };
  return {
    enabled: false,
    reason,
    verifying: false,
    verifyNotification: fail,
    verifyTransaction: fail,
    verifyRenewalInfo: fail,
  };
}

let cached: AppleVerifier | null = null;

export function getAppleVerifier(): AppleVerifier {
  if (cached) return cached;
  cached = build();
  return cached;
}

function build(): AppleVerifier {
  if (!config.appleBundleId) {
    return disabled(
      "APPLE_BUNDLE_ID não definido — sem ele não dá pra validar de qual app " +
        "a notificação veio.",
    );
  }

  // Modo inseguro explícito: decodifica e segue, sem provar nada.
  if (config.appleSkipVerification) {
    return {
      enabled: true,
      reason: null,
      verifying: false,
      async verifyNotification(p) {
        return decodeUnsafe<DecodedNotification>(p);
      },
      async verifyTransaction(p) {
        return decodeUnsafe<DecodedTransaction>(p);
      },
      async verifyRenewalInfo(p) {
        return decodeUnsafe<DecodedRenewalInfo>(p);
      },
    };
  }

  const roots = loadAppleRootCertificates();
  if (roots.length === 0) {
    return disabled(
      `Nenhum certificado raiz da Apple em "${config.appleRootCertsDir}". ` +
        "Rode `npm run certs:apple` (ou defina APPLE_ROOT_CERTS_B64).",
    );
  }

  let SignedDataVerifier: new (
    roots: Buffer[],
    onlineChecks: boolean,
    environment: string,
    bundleId: string,
    appAppleId?: number,
  ) => {
    verifyAndDecodeNotification(p: string): Promise<unknown>;
    verifyAndDecodeTransaction(p: string): Promise<unknown>;
    verifyAndDecodeRenewalInfo(p: string): Promise<unknown>;
  };

  try {
    // require preguiçoso: a lib só é carregada se o webhook for mesmo usar.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ SignedDataVerifier } = require("@apple/app-store-server-library"));
  } catch {
    return disabled(
      "Dependência @apple/app-store-server-library ausente — rode `npm install`.",
    );
  }

  // A Apple omite o appAppleId no ambiente de sandbox; passar undefined lá é
  // o comportamento certo, não um esquecimento.
  const verifier = new SignedDataVerifier(
    roots,
    config.appleOnlineChecks,
    config.appleEnvironment,
    config.appleBundleId,
    config.appleEnvironment === "Sandbox" ? undefined : (config.appleAppId ?? undefined),
  );

  return {
    enabled: true,
    reason: null,
    verifying: true,
    async verifyNotification(p) {
      return (await verifier.verifyAndDecodeNotification(p)) as DecodedNotification;
    },
    async verifyTransaction(p) {
      return (await verifier.verifyAndDecodeTransaction(p)) as DecodedTransaction;
    },
    async verifyRenewalInfo(p) {
      return (await verifier.verifyAndDecodeRenewalInfo(p)) as DecodedRenewalInfo;
    },
  };
}

/** Só pra teste — descarta o verifier memoizado. */
export function resetAppleVerifier(): void {
  cached = null;
}
