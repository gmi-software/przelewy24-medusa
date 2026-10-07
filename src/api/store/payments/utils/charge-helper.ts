import { MedusaRequest } from "@medusajs/framework/http";
import { PaymentSessionDTO } from "@medusajs/framework/types";
import {
  ContainerRegistrationKeys,
  Modules,
  PaymentSessionStatus,
} from "@medusajs/framework/utils";
import {
  getP24FailureDetails,
  P24FailureDetails,
} from "../../../../utils/p24-api-error";
import { buildLocalizedP24ErrorMessage } from "../../../../utils/p24-errors";
import { getSessionId } from "../../../../utils/p24-session-data";
import { PaymentProviderKeys } from "../../../../providers/przelewy24/types";

type ChargeExecutorResult = {
  orderId?: number;
  redirectUrl?: string;
  message?: string;
};

type ChargeExecutor = () => Promise<ChargeExecutorResult>;

type HandleChargeInput = {
  req: MedusaRequest;
  paymentSessionId?: string;
  execute: ChargeExecutor;
};

type P24ChargeResponse = {
  responseCode?: number;
  data?: Record<string, unknown>;
  message?: string;
};

export type P24ChargeFailureContext = {
  payment_session_id?: string;
  p24_session_id?: string;
  cart_id?: string;
  amount_grosze?: number;
  endpoint?: string;
  http_status?: number;
  p24_code?: string | number;
  p24_description?: string;
};

export function buildChargeFailureContext(input: {
  paymentSessionId?: string;
  sessionData?: Record<string, unknown> | null;
  cartId?: string;
  failure: P24FailureDetails;
}): P24ChargeFailureContext {
  const data = input.sessionData ?? {};
  const amountGrosze = data.amount_grosze;

  const context: P24ChargeFailureContext = {
    payment_session_id: input.paymentSessionId,
    p24_session_id: getSessionId(data),
    cart_id: input.cartId,
    amount_grosze:
      typeof amountGrosze === "number" && Number.isFinite(amountGrosze)
        ? amountGrosze
        : undefined,
    endpoint: input.failure.endpoint,
    http_status: input.failure.http_status,
    p24_code: input.failure.p24_code,
    p24_description: input.failure.p24_description,
  };

  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  ) as P24ChargeFailureContext;
}

export async function markPaymentSessionError(
  req: MedusaRequest,
  paymentSessionId: string,
  errorMessage: string,
  context: P24ChargeFailureContext = {},
  existingSession?: PaymentSessionDTO,
): Promise<void> {
  const paymentModule = req.scope.resolve(Modules.PAYMENT);
  const session =
    existingSession ??
    (await paymentModule.retrievePaymentSession(paymentSessionId));

  await paymentModule.updatePaymentSession({
    id: paymentSessionId,
    amount: session.amount,
    currency_code: session.currency_code,
    status: PaymentSessionStatus.ERROR,
    data: {
      ...(session.data ?? {}),
      error_message: errorMessage,
      error_http_status: context.http_status ?? null,
      error_p24_code: context.p24_code ?? null,
      error_p24_description: context.p24_description ?? null,
      error_endpoint: context.endpoint ?? null,
      error_session_id: context.p24_session_id ?? null,
      error_amount_grosze: context.amount_grosze ?? null,
      failed_at: new Date().toISOString(),
    },
  });
}

async function retrievePaymentSessionSafely(
  req: MedusaRequest,
  paymentSessionId: string,
): Promise<PaymentSessionDTO | undefined> {
  try {
    const paymentModule = req.scope.resolve(Modules.PAYMENT);
    return await paymentModule.retrievePaymentSession(paymentSessionId);
  } catch {
    return undefined;
  }
}

async function resolveCartIdSafely(
  req: MedusaRequest,
  paymentSessionId: string,
): Promise<string | undefined> {
  try {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
    const { data } = await query.graph({
      entity: "payment_session",
      fields: ["payment_collection.cart.id"],
      filters: { id: paymentSessionId },
    });
    const cartId = (
      data?.[0] as { payment_collection?: { cart?: { id?: unknown } } }
    )?.payment_collection?.cart?.id;
    return typeof cartId === "string" ? cartId : undefined;
  } catch {
    return undefined;
  }
}

export function parseP24ChargeResponse(
  response: P24ChargeResponse,
): ChargeExecutorResult {
  if (response.responseCode !== 0) {
    throw new Error(
      buildLocalizedP24ErrorMessage(
        response,
        (typeof response.data?.message === "string"
          ? response.data.message
          : response.message) || "Payment charge failed",
      ),
    );
  }

  return {
    orderId:
      typeof response.data?.orderId === "number"
        ? response.data.orderId
        : undefined,
    redirectUrl:
      typeof response.data?.redirectUrl === "string"
        ? response.data.redirectUrl
        : undefined,
    message:
      typeof response.data?.message === "string"
        ? response.data.message
        : undefined,
  };
}

export async function handleP24Charge({
  req,
  paymentSessionId,
  execute,
}: HandleChargeInput) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER);

  try {
    const result = await execute();

    return {
      success: true,
      orderId: result.orderId,
      redirectUrl: result.redirectUrl,
      message: result.message,
    };
  } catch (error) {
    const failure = getP24FailureDetails(error);
    const session = paymentSessionId
      ? await retrievePaymentSessionSafely(req, paymentSessionId)
      : undefined;
    const cartId = paymentSessionId
      ? await resolveCartIdSafely(req, paymentSessionId)
      : undefined;
    const context = buildChargeFailureContext({
      paymentSessionId,
      sessionData: session?.data,
      cartId,
      failure,
    });

    logger.error(
      `[p24-charge] ${failure.message} context=${JSON.stringify(context)}`,
    );

    if (paymentSessionId) {
      await markPaymentSessionError(
        req,
        paymentSessionId,
        failure.message,
        context,
        session,
      ).catch(
        (markError) => {
          logger.error(
            `[p24-charge] Failed to mark payment session ${paymentSessionId} as error: ${
              markError instanceof Error ? markError.message : "unknown"
            }`,
          );
        },
      );
    }

    throw error;
  }
}

type PaymentProviderServiceLike = {
  retrieveProvider: <TProvider>(providerId: string) => TProvider;
};

/**
 * Resolves PaymentProviderService via the payment module cradle; Medusa has no public API for this yet.
 */
type PaymentModuleWithProviderContainer = {
  __container__: {
    paymentProviderService: PaymentProviderServiceLike;
  };
};

type ContainerLike = {
  resolve: (key: string) => unknown;
};

export function resolvePaymentProviderById<T>(
  container: ContainerLike,
  providerId: string,
): T {
  const paymentModule = container.resolve(
    Modules.PAYMENT,
  ) as unknown as PaymentModuleWithProviderContainer;

  return paymentModule.__container__.paymentProviderService.retrieveProvider<T>(
    providerId,
  );
}

export function assertPaymentSessionProvider(
  session: { provider_id: string },
  expectedProviderId: string,
): void {
  if (session.provider_id !== expectedProviderId) {
    throw new Error("Payment session provider mismatch");
  }
}

export function resolvePaymentSessionIdempotencyKey(session: {
  id: string;
  data?: Record<string, unknown> | null;
}): string {
  const medusaPaymentSessionId = session.data?.medusa_payment_session_id;

  if (
    typeof medusaPaymentSessionId === "string" &&
    medusaPaymentSessionId.length > 0
  ) {
    return medusaPaymentSessionId;
  }

  return session.id;
}

export async function assertBlikChargeMatchesPaymentSession(
  req: MedusaRequest,
  paymentSessionId: string,
  token: string,
  expectedProviderId: string,
): Promise<void> {
  const paymentModule = req.scope.resolve(Modules.PAYMENT);
  const session = await paymentModule.retrievePaymentSession(paymentSessionId);

  assertPaymentSessionProvider(session, expectedProviderId);

  const sessionToken =
    typeof session.data?.token === "string" ? session.data.token : undefined;

  if (!sessionToken || sessionToken !== token) {
    throw new Error("Payment session token mismatch");
  }
}

export type P24TransactionStatusQueryProvider = {
  queryTransactionStatus: (
    sessionId: string,
  ) => Promise<{ medusaStatus: string; p24Status: number }>;
};

function isPaymentProviderKey(value: string): value is PaymentProviderKeys {
  return Object.values(PaymentProviderKeys).includes(
    value as PaymentProviderKeys,
  );
}

function resolveProviderKeyFromProviderId(
  providerId: string,
): PaymentProviderKeys {
  const match = providerId.match(/^pp_(.+)_przelewy24$/);

  if (match && isPaymentProviderKey(match[1])) {
    return match[1];
  }

  throw new Error("Unsupported payment provider");
}

export function resolveP24ProviderKeyForStatus(input: {
  provider_key?: PaymentProviderKeys;
  provider_id?: string;
}): PaymentProviderKeys {
  const providerKeyFromId = input.provider_id
    ? resolveProviderKeyFromProviderId(input.provider_id)
    : undefined;

  if (input.provider_key) {
    if (providerKeyFromId && providerKeyFromId !== input.provider_key) {
      throw new Error("Payment provider mismatch");
    }

    return input.provider_key;
  }

  if (providerKeyFromId) {
    return providerKeyFromId;
  }

  return PaymentProviderKeys.P24_BLIK;
}

export function resolveP24Provider<T>(
  req: MedusaRequest,
  providerKey: string,
): T {
  const providerId = `pp_${providerKey}_przelewy24`;

  return resolvePaymentProviderById<T>(req.scope, providerId);
}
