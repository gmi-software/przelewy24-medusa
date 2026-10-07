import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";

import {
  resolveP24Provider,
  resolveP24ProviderKeyForStatus,
  type P24TransactionStatusQueryProvider,
} from "../../utils/charge-helper";
import { PaymentProviderKeys } from "../../../../../providers/przelewy24/types";
import { getP24UserFacingMessage } from "../../../../../utils/p24-api-error";

const statusSchema = z.object({
  session_id: z.string().min(1),
  provider_key: z.nativeEnum(PaymentProviderKeys).optional(),
  provider_id: z.string().min(1).optional(),
});

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const validationResult = statusSchema.safeParse(req.body);

  if (!validationResult.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: validationResult.error.errors.map(
        (err) => `${err.path.join(".")}: ${err.message}`,
      ),
    });
  }

  const { session_id, provider_key, provider_id } = validationResult.data;

  try {
    const providerKey = resolveP24ProviderKeyForStatus({
      provider_key,
      provider_id,
    });

    const provider = resolveP24Provider<P24TransactionStatusQueryProvider>(
      req,
      providerKey,
    );

    const { medusaStatus, p24Status } = await provider.queryTransactionStatus(
      session_id,
    );

    return res.status(200).json({
      session_id,
      p24_status: p24Status,
      status: medusaStatus,
    });
  } catch (error) {
    return res.status(400).json({
      error: "Failed to query transaction status",
      message: getP24UserFacingMessage(error, "Failed to query transaction status"),
    });
  }
}
