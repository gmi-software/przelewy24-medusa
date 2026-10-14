import {
  ProviderWebhookPayload,
  WebhookActionResult,
} from "@medusajs/types";
import { PaymentActions } from "@medusajs/framework/utils";

import { P24ApiService } from "../services/p24-api";
import { P24WebhookPayload } from "../types";
import { getAmountFromSmallestUnit } from "../../../utils/get-smallest-unit";
import { createP24Logger, redactUnknown } from "../../../utils/p24-logger";

import { fetchTransactionDetailsAndStatus } from "./p24-transaction-status";

export function extractP24WebhookSourceIp(
  headers?: Record<string, unknown>,
): string | undefined {
  if (!headers) {
    return undefined;
  }

  const cfConnectingIpRaw =
    headers["cf-connecting-ip"] || headers["CF-Connecting-IP"];
  const cfConnectingIp =
    typeof cfConnectingIpRaw === "string" ? cfConnectingIpRaw.trim() : "";
  if (cfConnectingIp) {
    return cfConnectingIp;
  }

  const realIpRaw = headers["x-real-ip"] || headers["X-Real-IP"];
  const realIp = typeof realIpRaw === "string" ? realIpRaw.trim() : "";
  if (realIp) {
    return realIp;
  }

  const forwardedFor = headers["x-forwarded-for"] || headers["X-Forwarded-For"];
  if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
    const ips = forwardedFor
      .split(",")
      .map((ip) => ip.trim())
      .filter(Boolean);
    return ips.length > 0 ? ips[0] : undefined;
  }

  return undefined;
}

type P24WebhookDeps = {
  p24Api: P24ApiService;
  logger: ReturnType<typeof createP24Logger>;
  findMedusaPaymentSessionId: (p24SessionId: string) => Promise<string>;
  buildError: (message: string, error?: unknown) => Error;
};

export async function processP24Webhook(
  deps: P24WebhookDeps,
  webhookData: ProviderWebhookPayload["payload"],
): Promise<WebhookActionResult> {
  const { data, rawData, headers } = webhookData;

  try {
    const payload = data as unknown as P24WebhookPayload;
    const { sessionId, orderId, amount, currency, sign } = payload;

    const sourceIp = extractP24WebhookSourceIp(headers);
    if (!deps.p24Api.isAllowedWebhookIp(sourceIp)) {
      deps.logger.error(
        `Rejected P24 webhook from unauthorized IP: ${sourceIp ?? "unknown"}`,
      );
      return { action: PaymentActions.NOT_SUPPORTED };
    }

    if (!deps.p24Api.verifyWebhookSignature(payload, sign)) {
      deps.logger.error(`Invalid webhook signature for session ${sessionId}`);
      return { action: PaymentActions.NOT_SUPPORTED };
    }

    if (typeof currency !== "string" || !currency.trim()) {
      deps.logger.error(
        `Missing or invalid currency in webhook payload for session ${sessionId}`,
      );
      return { action: PaymentActions.NOT_SUPPORTED };
    }

    const amountNum = Number(amount);
    if (amount == null || !Number.isFinite(amountNum) || amountNum < 0) {
      deps.logger.error(
        `Missing or invalid amount in webhook payload for session ${sessionId}`,
      );
      return { action: PaymentActions.NOT_SUPPORTED };
    }

    const amountNormal = getAmountFromSmallestUnit(amount, currency);
    const medusaPaymentSessionId =
      await deps.findMedusaPaymentSessionId(sessionId);

    // An unverified transaction is never settled to the merchant, so the
    // customer keeps the money instead of the order getting a wrong amount.
    if (
      payload.originAmount != null &&
      Number(payload.originAmount) !== amountNum
    ) {
      deps.logger.error(
        `P24 transaction amount mismatch for session ${sessionId} (order ${orderId}): paid ${amountNum}, registered ${payload.originAmount}; left unverified`,
      );
      return {
        action: PaymentActions.FAILED,
        data: {
          session_id: medusaPaymentSessionId,
          amount: amountNormal,
        },
      };
    }

    const verification = await deps.p24Api.verifyTransaction(
      sessionId,
      amount,
      currency,
      orderId,
    );

    if (
      verification.responseCode !== 0 ||
      verification.data.status !== "success"
    ) {
      deps.logger.error(
        `Transaction verification failed - responseCode: ${verification.responseCode}, status: ${verification.data.status}`,
      );
      return {
        action: PaymentActions.FAILED,
        data: {
          session_id: medusaPaymentSessionId,
          amount: amountNormal,
        },
      };
    }

    const { medusaStatus } = await fetchTransactionDetailsAndStatus(
      deps,
      sessionId,
    );

    const webhookResultData = {
      session_id: medusaPaymentSessionId,
      amount: amountNormal,
      order_id: orderId,
      methodId: payload.methodId,
      paymentMethod: payload.methodId,
    };

    switch (medusaStatus) {
      case "captured":
      case "authorized":
        return {
          action: PaymentActions.SUCCESSFUL,
          data: webhookResultData,
        };
      case "pending":
        return {
          action: PaymentActions.PENDING,
          data: webhookResultData,
        };
      case "canceled":
        return {
          action: PaymentActions.CANCELED,
          data: webhookResultData,
        };
      case "error":
        return {
          action: PaymentActions.FAILED,
          data: webhookResultData,
        };
      default:
        return {
          action: PaymentActions.NOT_SUPPORTED,
          data: webhookResultData,
        };
    }
  } catch (error) {
    deps.logger.error(
      `Error processing P24 webhook: ${(error as Error).message} raw=${JSON.stringify(
        redactUnknown(rawData),
      )}`,
    );

    try {
      const fallbackPayload = webhookData.data as unknown as P24WebhookPayload;
      const { sessionId, amount, currency } = fallbackPayload;

      const amountNumFallback = Number(amount);
      if (
        sessionId &&
        amount != null &&
        Number.isFinite(amountNumFallback) &&
        amountNumFallback >= 0 &&
        typeof currency === "string" &&
        currency.trim()
      ) {
        const amountNormal = getAmountFromSmallestUnit(amount, currency);
        return {
          action: PaymentActions.FAILED,
          data: {
            session_id: sessionId,
            amount: amountNormal,
          },
        };
      }
    } catch (fallbackError) {
      deps.logger.error(
        `Failed to extract fallback webhook data: ${(fallbackError as Error).message}`,
      );
    }

    throw error;
  }
}
