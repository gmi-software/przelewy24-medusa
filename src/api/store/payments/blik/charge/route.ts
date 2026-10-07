import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";

import P24BlikService from "../../../../../providers/przelewy24/services/p24-blik";
import {
  assertBlikChargeMatchesPaymentSession,
  handleP24Charge,
  parseP24ChargeResponse,
  resolveP24Provider,
} from "../../utils/charge-helper";
import { PaymentProviderKeys } from "../../../../../providers/przelewy24/types";
import { getP24UserFacingMessage } from "../../../../../utils/p24-api-error";

const BLIK_PROVIDER_ID = `pp_${PaymentProviderKeys.P24_BLIK}_przelewy24`;

const blikChargeSchema = z.object({
  token: z.string().min(1, "Token is required").max(200, "Token is too long"),
  blikCode: z.string().regex(/^\d{6}$/, "BLIK code must be exactly 6 digits"),
  payment_session_id: z
    .string()
    .min(1, "Payment session id is required"),
});

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const validationResult = blikChargeSchema.safeParse(req.body);

  if (!validationResult.success) {
    const errors = validationResult.error.errors.map(
      (err) => `${err.path.join(".")}: ${err.message}`,
    );

    return res.status(400).json({
      error: "Validation failed",
      details: errors,
    });
  }

  const { token, blikCode, payment_session_id } = validationResult.data;

  try {
    await assertBlikChargeMatchesPaymentSession(
      req,
      payment_session_id,
      token,
      BLIK_PROVIDER_ID,
    );

    const provider = resolveP24Provider<P24BlikService>(
      req,
      PaymentProviderKeys.P24_BLIK,
    );

    const result = await handleP24Charge({
      req,
      paymentSessionId: payment_session_id,
      execute: async () => {
        const response = await provider.chargeBlikPayment(token, blikCode);
        return parseP24ChargeResponse(response);
      },
    });

    return res.status(200).json(result);
  } catch (error) {
    return res.status(400).json({
      error: "BLIK payment failed",
      message: getP24UserFacingMessage(error, "BLIK payment failed"),
    });
  }
}
