import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils";

import P24BlikService from "../../../../providers/przelewy24/services/p24-blik";
import {
  handleP24BlikNotification,
  P24_BLIK_NOTIFICATION_PATH,
} from "../../../../providers/przelewy24/core/p24-blik-notification";
import { extractP24WebhookSourceIp } from "../../../../providers/przelewy24/core/p24-webhook";
import { PaymentProviderKeys } from "../../../../providers/przelewy24/types";
import {
  markPaymentSessionError,
  resolveP24Provider,
} from "../../../store/payments/utils/charge-helper";

const LOG_PREFIX = "[p24-blik-notification]";

/**
 * Additional BLIK notification (`urlCardPaymentNotification`). P24 sends it
 * for rejected BLIK charges too, which `urlStatus` never reports.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER);
  const paymentModule = req.scope.resolve(Modules.PAYMENT);
  const provider = resolveP24Provider<P24BlikService>(
    req,
    PaymentProviderKeys.P24_BLIK,
  );

  const outcome = await handleP24BlikNotification(
    {
      isAllowedSource: (sourceIp) =>
        provider.isAllowedNotificationSource(sourceIp),
      verifySignature: (payload) =>
        provider.verifyBlikNotificationSignature(payload),
      queryTransactionStatus: (p24SessionId) =>
        provider.queryTransactionStatus(p24SessionId),
      retrievePaymentSession: (id) => paymentModule.retrievePaymentSession(id),
      markFailed: async (session, payload) => {
        const code = String(payload.result.error);
        const description =
          typeof payload.result.message === "string"
            ? payload.result.message
            : undefined;
        const data = (session.data ?? {}) as Record<string, unknown>;

        await markPaymentSessionError(
          req,
          session.id,
          `P24 BLIK payment rejected: ${code}${description ? ` - ${description}` : ""}`,
          {
            payment_session_id: session.id,
            p24_session_id: payload.sessionId,
            endpoint: P24_BLIK_NOTIFICATION_PATH,
            p24_code: code,
            p24_description: description,
            amount_grosze:
              typeof data.amount_grosze === "number"
                ? data.amount_grosze
                : undefined,
          },
          session,
        );
      },
      warn: (message) => logger.warn(`${LOG_PREFIX} ${message}`),
    },
    {
      body: req.body,
      sourceIp: extractP24WebhookSourceIp(
        req.headers as Record<string, unknown>,
      ),
    },
  );

  switch (outcome.kind) {
    case "rejected":
      logger.warn(`${LOG_PREFIX} rejected: ${outcome.reason}`);
      return res.status(outcome.httpStatus).json({ error: outcome.reason });
    case "ignored":
      logger.info(`${LOG_PREFIX} ignored: ${outcome.reason}`);
      return res.status(200).json({ received: true });
    case "marked_failed":
      logger.info(
        `${LOG_PREFIX} payment session ${outcome.paymentSessionId} marked as failed`,
      );
      return res.status(200).json({ received: true });
    default: {
      const unhandled: never = outcome;
      throw new Error(`Unhandled BLIK notification outcome: ${unhandled}`);
    }
  }
}
