import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { PaymentSessionDTO } from "@medusajs/framework/types";
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils";
import { z } from "zod";

import P24CardsService from "../../../../../providers/przelewy24/services/p24-cards";
import {
  assertCardChargeMatchesPaymentSession,
  buildChargeFailureContext,
  resolveP24Provider,
  resolvePaymentSessionIdempotencyKey,
} from "../../utils/charge-helper";
import { PaymentProviderKeys } from "../../../../../providers/przelewy24/types";
import {
  getP24FailureDetails,
  getP24UserFacingMessage,
  isP24UnknownOutcomeError,
} from "../../../../../utils/p24-api-error";
import {
  normalizeP24SessionData,
  P24_CHARGE_SUBMITTED_AT_KEY,
} from "../../../../../utils/p24-session-data";
import { withP24PaymentSessionLock } from "../../../../../utils/p24-payment-session-lock";

const CARDS_PROVIDER_ID = `pp_${PaymentProviderKeys.P24_CARDS}_przelewy24`;

const cardRegisterSchema = z.object({
  ref_id: z.string().min(1, "Card reference id is required").max(200),
  payment_session_id: z.string().min(1, "Payment session id is required"),
});

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const validationResult = cardRegisterSchema.safeParse(req.body);

  if (!validationResult.success) {
    const errors = validationResult.error.errors.map(
      (err) => `${err.path.join(".")}: ${err.message}`,
    );

    return res.status(400).json({
      error: "Validation failed",
      details: errors,
    });
  }

  const { ref_id, payment_session_id } = validationResult.data;

  let paymentSession: PaymentSessionDTO | undefined;

  try {
    const paymentModule = req.scope.resolve(Modules.PAYMENT);
    const provider = resolveP24Provider<P24CardsService>(
      req,
      PaymentProviderKeys.P24_CARDS,
    );

    const result = await withP24PaymentSessionLock(
      req.scope,
      payment_session_id,
      async () => {
        const session = await assertCardChargeMatchesPaymentSession(
          req,
          payment_session_id,
          CARDS_PROVIDER_ID,
        );
        paymentSession = session;

        // Stamped once P24 may hold a registration for this sessionId; a
        // refused registration leaves the session open for another card.
        const markCharged = (data: Record<string, unknown>) =>
          paymentModule.updatePaymentSession({
            id: payment_session_id,
            amount: session.amount,
            currency_code: session.currency_code,
            data: normalizeP24SessionData({
              ...data,
              [P24_CHARGE_SUBMITTED_AT_KEY]: new Date().toISOString(),
            }),
          });

        let registered: Awaited<ReturnType<P24CardsService["registerWithRefId"]>>;

        try {
          registered = await provider.registerWithRefId({
            refId: ref_id,
            input: {
              amount: session.amount,
              currency_code: session.currency_code,
              context: {
                idempotency_key: resolvePaymentSessionIdempotencyKey(session),
              },
              data: {
                ...(session.data ?? {}),
                regulation_accept: true,
              },
            },
          });
        } catch (error) {
          if (isP24UnknownOutcomeError(error)) {
            await markCharged(session.data ?? {}).catch((markError) => {
              req.scope
                .resolve(ContainerRegistrationKeys.LOGGER)
                .error(
                  `[p24-card-charge] Failed to mark payment session ${payment_session_id} as charged: ${
                    markError instanceof Error ? markError.message : "unknown"
                  }`,
                );
            });
          }

          throw error;
        }

        await markCharged({
          ...(session.data ?? {}),
          ...(registered.sessionData ?? {}),
          pending_card_tokenization: false,
          token: registered.token,
        });

        return registered;
      },
    );

    return res.status(200).json({
      success: true,
      token: result.token,
      chargeScriptUrl: result.chargeScriptUrl,
      sessionId: result.sessionId,
    });
  } catch (error) {
    const failure = getP24FailureDetails(error);
    const context = buildChargeFailureContext({
      paymentSessionId: payment_session_id,
      sessionData: paymentSession?.data,
      failure,
    });

    req.scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .error(
        `[p24-card-charge] ${failure.message} context=${JSON.stringify(context)}`,
      );

    return res.status(isP24UnknownOutcomeError(error) ? 502 : 400).json({
      error: "Card payment failed",
      message: getP24UserFacingMessage(error, "Card payment failed"),
    });
  }
}
