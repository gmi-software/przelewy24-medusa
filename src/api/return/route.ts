import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER);
  const { sessionId, status } = req.query;

  try {
    logger.info(`P24 payment return: sessionId=${sessionId}, status=${status}`);

    // Redirect to frontend with payment result
    const redirectUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const returnUrl = `${redirectUrl}/payment/return?session_id=${sessionId}&status=${status}`;

    res.redirect(302, returnUrl);
  } catch (error: any) {
    logger.error(
      `Error handling P24 return: ${error?.message || "Unknown error"}`
    );

    // Redirect to error page
    const redirectUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const errorUrl = `${redirectUrl}/payment/error`;

    res.redirect(302, errorUrl);
  }
}
