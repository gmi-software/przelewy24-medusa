import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { z } from "zod";

const blikPaymentSchema = z.object({
  token: z.string().min(1, "Token is required").max(100, "Token is too long"),
  blikCode: z.string().regex(/^\d{6}$/, "BLIK code must be exactly 6 digits"),
});

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER);

  try {
    const validationResult = blikPaymentSchema.safeParse(req.body);

    if (!validationResult.success) {
      const errors = validationResult.error.errors.map(
        (err) => `${err.path.join(".")}: ${err.message}`
      );
      res.status(400).json({
        error: "Validation failed",
        details: errors,
      });
      return;
    }

    const { token, blikCode } = validationResult.data;

    const posId = process.env.P24_POS_ID;
    const apiKey = process.env.P24_API_KEY;
    const sandbox = process.env.NODE_ENV !== "production";

    if (!posId || !apiKey) {
      logger.error(
        "P24 configuration missing: P24_POS_ID or P24_API_KEY not set"
      );
      res.status(500).json({
        error: "Configuration error",
        message: "P24 configuration is incomplete",
      });
      return;
    }

    const baseURL = sandbox
      ? "https://sandbox.przelewy24.pl/api/v1"
      : "https://secure.przelewy24.pl/api/v1";

    const url = `${baseURL}/paymentMethod/blik/chargeByCode`;

    const credentials = Buffer.from(`${posId}:${apiKey}`).toString("base64");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify({
        token,
        blikCode,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(
        `P24 API request failed: ${response.status} ${response.statusText} - ${errorText}`
      );
      res.status(400).json({
        error: "P24 API request failed",
        details: errorText,
        status: response.status,
      });
      return;
    }

    const blikResponse = await response.json();

    if (blikResponse.responseCode !== 0) {
      logger.error(
        `BLIK payment failed: ${blikResponse.responseCode} - ${
          blikResponse.data?.message || "Unknown error"
        }`
      );
      res.status(400).json({
        error: "BLIK payment failed",
        details: blikResponse.data?.message || "Unknown error",
        responseCode: blikResponse.responseCode,
      });
      return;
    }

    // BLIK payment initiated successfully
    // The actual payment confirmation will come via webhook
    res.status(200).json({
      success: true,
      message: "BLIK payment initiated successfully",
      data: {
        token,
        orderId: blikResponse.data.orderId,
        message: blikResponse.data.message,
      },
    });
  } catch (error: any) {
    logger.error(
      `Error processing BLIK payment: ${error?.message || "Unknown error"}`
    );

    res.status(500).json({
      error: "Internal server error",
      message: error?.message || "Unknown error occurred",
    });
  }
}
