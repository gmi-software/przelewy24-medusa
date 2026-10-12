import { PaymentSessionDTO } from "@medusajs/framework/types";
import { PaymentSessionStatus } from "@medusajs/framework/utils";

import { P24BlikNotificationPayload, PaymentProviderKeys } from "../types";
import {
  getSessionId,
  inferMedusaPaymentSessionIdFromP24SessionId,
} from "../../../utils/p24-session-data";

export const P24_BLIK_NOTIFICATION_PATH = "/hooks/p24/blik-notification";

const BLIK_PROVIDER_ID = `pp_${PaymentProviderKeys.P24_BLIK}_przelewy24`;

/** Statuses in which a BLIK charge can still be waiting for the bank. */
const AWAITING_STATUSES = new Set<string>([
  PaymentSessionStatus.PENDING,
  PaymentSessionStatus.REQUIRES_MORE,
]);

const PAID_STATUSES = new Set<string>([
  PaymentSessionStatus.AUTHORIZED,
  PaymentSessionStatus.CAPTURED,
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Accepts the documented `{ data: {...}, sign }` envelope as well as a flat
 * body. Values are kept exactly as received because the signature hashes them.
 */
export function parseP24BlikNotification(
  body: unknown,
): P24BlikNotificationPayload | null {
  let parsed: unknown = body;

  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }

  if (!isRecord(parsed)) {
    return null;
  }

  const fields = isRecord(parsed.data) ? parsed.data : parsed;
  const sign = fields.sign ?? parsed.sign;

  if (
    typeof fields.sessionId !== "string" ||
    !fields.sessionId ||
    fields.orderId == null ||
    fields.method == null ||
    !isRecord(fields.result) ||
    typeof sign !== "string" ||
    !sign
  ) {
    return null;
  }

  return {
    orderId: fields.orderId as number,
    sessionId: fields.sessionId,
    method: fields.method as number,
    result: fields.result,
    sign,
  };
}

export type P24BlikNotificationVerdict = "success" | "failure" | "unknown";

/**
 * `result.status` wins when present: P24 sends `PENDING` while the payment
 * still waits in the banking app, then `AUTHORIZED` or `DECLINED`. Otherwise
 * `result.error` is `0` on success and anything else is a rejection.
 */
export function classifyP24BlikNotification(
  result: Record<string, unknown>,
): P24BlikNotificationVerdict {
  const status =
    typeof result.status === "string" ? result.status.trim().toUpperCase() : "";

  if (status === "PENDING") {
    return "unknown";
  }
  if (status === "AUTHORIZED") {
    return "success";
  }
  if (status === "DECLINED") {
    return "failure";
  }

  const error = result.error;

  if (error === undefined || error === null || error === "") {
    return "unknown";
  }

  return String(error).trim() === "0" ? "success" : "failure";
}

export type P24BlikNotificationOutcome =
  | { kind: "rejected"; httpStatus: 400 | 403; reason: string }
  | { kind: "ignored"; reason: string }
  | { kind: "marked_failed"; paymentSessionId: string };

export type P24BlikNotificationDeps = {
  isAllowedSource: (sourceIp: string | undefined) => boolean;
  verifySignature: (payload: P24BlikNotificationPayload) => boolean;
  queryTransactionStatus: (
    p24SessionId: string,
  ) => Promise<{ medusaStatus: string }>;
  retrievePaymentSession: (id: string) => Promise<PaymentSessionDTO>;
  markFailed: (
    session: PaymentSessionDTO,
    payload: P24BlikNotificationPayload,
  ) => Promise<void>;
  withSessionLock: <T>(
    paymentSessionId: string,
    job: () => Promise<T>,
  ) => Promise<T>;
  warn: (message: string) => void;
};

type AwaitingSessionLookup =
  | { session: PaymentSessionDTO }
  | { reason: string };

async function findAwaitingBlikSession(
  deps: P24BlikNotificationDeps,
  paymentSessionId: string,
  p24SessionId: string,
): Promise<AwaitingSessionLookup> {
  let session: PaymentSessionDTO;
  try {
    session = await deps.retrievePaymentSession(paymentSessionId);
  } catch {
    return { reason: "payment session not found" };
  }

  if (session.provider_id !== BLIK_PROVIDER_ID) {
    return { reason: `provider ${session.provider_id}` };
  }

  const data = (session.data ?? {}) as Record<string, unknown>;
  if (getSessionId(data) !== p24SessionId) {
    return { reason: "superseded P24 registration" };
  }

  if (!AWAITING_STATUSES.has(session.status)) {
    return { reason: `session already ${session.status}` };
  }

  return { session };
}

/**
 * Marks the BLIK session as failed when P24 reports a rejected charge, so the
 * storefront stops waiting for a webhook that `urlStatus` never sends on
 * failure. Success stays with `urlStatus` → verify → capture.
 *
 * Only the session's current registration is touched: a notification for a
 * superseded P24 session id, a session that already settled, or a transaction
 * P24 reports as paid is acknowledged and ignored.
 */
export async function handleP24BlikNotification(
  deps: P24BlikNotificationDeps,
  input: { body: unknown; sourceIp: string | undefined },
): Promise<P24BlikNotificationOutcome> {
  const payload = parseP24BlikNotification(input.body);

  if (!payload) {
    return { kind: "rejected", httpStatus: 400, reason: "invalid payload" };
  }

  if (!deps.isAllowedSource(input.sourceIp)) {
    return {
      kind: "rejected",
      httpStatus: 403,
      reason: `unauthorized source ${input.sourceIp ?? "unknown"}`,
    };
  }

  if (!deps.verifySignature(payload)) {
    return { kind: "rejected", httpStatus: 403, reason: "invalid signature" };
  }

  const verdict = classifyP24BlikNotification(payload.result);

  if (verdict !== "failure") {
    return { kind: "ignored", reason: `result ${verdict}` };
  }

  const paymentSessionId = inferMedusaPaymentSessionIdFromP24SessionId(
    payload.sessionId,
  );

  if (!paymentSessionId) {
    return { kind: "ignored", reason: "not a Medusa payment session" };
  }

  return deps.withSessionLock(paymentSessionId, () =>
    settleRejection(deps, paymentSessionId, payload),
  );
}

async function settleRejection(
  deps: P24BlikNotificationDeps,
  paymentSessionId: string,
  payload: P24BlikNotificationPayload,
): Promise<P24BlikNotificationOutcome> {
  const lookup = await findAwaitingBlikSession(
    deps,
    paymentSessionId,
    payload.sessionId,
  );

  if ("reason" in lookup) {
    return { kind: "ignored", reason: lookup.reason };
  }

  try {
    const { medusaStatus } = await deps.queryTransactionStatus(
      payload.sessionId,
    );

    if (PAID_STATUSES.has(medusaStatus)) {
      return { kind: "ignored", reason: `P24 reports ${medusaStatus}` };
    }
  } catch (error) {
    // The signature already proves P24 sent the rejection.
    deps.warn(
      `status check failed for ${payload.sessionId}, trusting signed rejection: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // The lock only excludes plugin writers; the P24 round trip above leaves
  // room for the host (e.g. urlStatus capture) to settle the session.
  const latest = await findAwaitingBlikSession(
    deps,
    paymentSessionId,
    payload.sessionId,
  );

  if ("reason" in latest) {
    return { kind: "ignored", reason: latest.reason };
  }

  await deps.markFailed(latest.session, payload);

  return { kind: "marked_failed", paymentSessionId: latest.session.id };
}
