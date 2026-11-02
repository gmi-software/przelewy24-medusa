import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

import { resolveP24Provider } from "../store/payments/utils/charge-helper";
import {
  P24Options,
  PaymentProviderKeys,
} from "../../providers/przelewy24/types";

/** `frontend_url` of the first registered P24 provider; env only as fallback. */
function resolveFrontendUrl(req: MedusaRequest): string {
  for (const providerKey of Object.values(PaymentProviderKeys)) {
    try {
      const frontendUrl = resolveP24Provider<{ options?: P24Options }>(
        req,
        providerKey,
      )?.options?.frontend_url;

      if (typeof frontendUrl === "string" && frontendUrl.trim()) {
        return frontendUrl.trim();
      }
    } catch {
      // Provider not registered in this project.
    }
  }

  return process.env.FRONTEND_URL || "http://localhost:3000";
}

function queryValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER);
  const sessionId = queryValue(req.query.sessionId);
  const status = queryValue(req.query.status);
  const redirectUrl = resolveFrontendUrl(req);

  try {
    logger.info(`P24 payment return: sessionId=${sessionId}, status=${status}`);

    // Redirect to frontend with payment result
    const params = new URLSearchParams({ session_id: sessionId, status });
    const returnUrl = `${redirectUrl}/payment/return?${params.toString()}`;

    res.redirect(302, returnUrl);
  } catch (error: any) {
    logger.error(
      `Error handling P24 return: ${error?.message || "Unknown error"}`
    );

    // Redirect to error page
    const errorUrl = `${redirectUrl}/payment/error`;

    res.redirect(302, errorUrl);
  }
}
