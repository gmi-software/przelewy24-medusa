import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";

import { resolveP24Provider } from "../store/payments/utils/charge-helper";
import {
  P24Options,
  PaymentProviderKeys,
} from "../../providers/przelewy24/types";

const PROVIDER_LOOKUP_TIMEOUT_MS = 2000;

/**
 * The P24 providers this project registered. Resolving one that is not makes
 * Medusa log an error first, on every return.
 */
async function registeredProviderKeys(req: MedusaRequest): Promise<string[]> {
  const keys = Object.values(PaymentProviderKeys);
  let timer: NodeJS.Timeout | undefined;
  try {
    // The customer is waiting on this redirect: a stuck query must not hold it.
    const registered = await Promise.race([
      req.scope
        .resolve(Modules.PAYMENT)
        .listPaymentProviders({ id: keys.map((key) => `pp_${key}_przelewy24`) }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${PROVIDER_LOOKUP_TIMEOUT_MS}ms`)),
          PROVIDER_LOOKUP_TIMEOUT_MS,
        );
      }),
    ]);
    const ids = new Set(registered.map((provider) => provider.id));
    return keys.filter((key) => ids.has(`pp_${key}_przelewy24`));
  } catch (error) {
    req.scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .warn(
        `P24 return: could not list payment providers, trying every P24 key: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    return keys;
  } finally {
    clearTimeout(timer);
  }
}

/** `frontend_url` of the first registered P24 provider; env only as fallback. */
async function resolveFrontendUrl(req: MedusaRequest): Promise<string> {
  for (const providerKey of await registeredProviderKeys(req)) {
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
  const redirectUrl = await resolveFrontendUrl(req);

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
