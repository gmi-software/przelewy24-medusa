const MEDUSA_PAYMENT_SESSION_ID_WITH_RETRY_SUFFIX =
  /^(payses_[0-9A-Z]{26})(?:-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i;

/**
 * P24 transaction sessionId is usually the Medusa payment session id (`payses_*`).
 * Retried payments append a UUID suffix after updatePayment.
 */
export function inferMedusaPaymentSessionIdFromP24SessionId(
  p24SessionId: string,
): string | undefined {
  const match = p24SessionId.match(MEDUSA_PAYMENT_SESSION_ID_WITH_RETRY_SUFFIX);
  return match?.[1];
}

/** Set on the payment session once P24 accepted a charge for its token. */
export const P24_CHARGE_SUBMITTED_AT_KEY = "charge_submitted_at";

export type NormalizedP24SessionData = {
  session_id: string;
  token?: string;
  order_id?: number;
  redirect_url?: string;
  amount?: number;
  currency?: string;
  currency_code?: string;
  p24_status?: number;
  [key: string]: unknown;
};

export function getSessionId(data?: Record<string, unknown> | null): string | undefined {
  if (!data) {
    return undefined;
  }

  const sessionId = data.session_id ?? data.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0
    ? sessionId
    : undefined;
}

export function getOrderId(data?: Record<string, unknown> | null): number | undefined {
  if (!data) {
    return undefined;
  }

  const orderId = data.order_id ?? data.orderId;
  if (typeof orderId === "number" && Number.isFinite(orderId)) {
    return orderId;
  }

  if (typeof orderId === "string" && orderId.trim().length > 0) {
    const parsed = Number(orderId);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

export function getToken(data?: Record<string, unknown> | null): string | undefined {
  if (!data) {
    return undefined;
  }

  const token = data.token;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

export function normalizeP24SessionData(
  data?: Record<string, unknown> | null,
): NormalizedP24SessionData {
  if (!data) {
    return { session_id: "" };
  }

  const sessionId = getSessionId(data);
  const orderId = getOrderId(data);
  const token = getToken(data);

  return {
    ...data,
    session_id: sessionId ?? "",
    ...(orderId != null ? { order_id: orderId, orderId } : {}),
    ...(token ? { token } : {}),
    ...(typeof data.currency === "string"
      ? { currency: data.currency, currency_code: data.currency }
      : {}),
  };
}
