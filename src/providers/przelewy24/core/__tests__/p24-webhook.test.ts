import { describe, expect, it, vi } from "vitest";
import { PaymentActions } from "@medusajs/framework/utils";

import { P24ApiService } from "../../services/p24-api";
import {
  P24ApiError,
  P24RequestError,
} from "../../../../utils/p24-api-error";
import {
  extractP24WebhookSourceIp,
  processP24Webhook,
} from "../p24-webhook";

const WEBHOOK_PAYLOAD = {
  merchantId: 12345,
  posId: 12345,
  sessionId: "p24-session-1",
  amount: 4999,
  originAmount: 4999,
  currency: "PLN",
  orderId: 42,
  methodId: 64,
  statement: "order-1",
  sign: "valid-sign",
};

const createLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const createDeps = (
  overrides: Partial<{
    isAllowedWebhookIp: ReturnType<typeof vi.fn>;
    verifyWebhookSignature: ReturnType<typeof vi.fn>;
    verifyTransaction: ReturnType<typeof vi.fn>;
    getTransactionBySessionId: ReturnType<typeof vi.fn>;
    findMedusaPaymentSessionId: ReturnType<typeof vi.fn>;
  }> = {},
) => {
  const logger = createLogger();

  const p24Api = {
    isAllowedWebhookIp: overrides.isAllowedWebhookIp ?? vi.fn().mockReturnValue(true),
    verifyWebhookSignature:
      overrides.verifyWebhookSignature ?? vi.fn().mockReturnValue(true),
    verifyTransaction:
      overrides.verifyTransaction ??
      vi.fn().mockResolvedValue({
        responseCode: 0,
        data: { status: "success", orderId: 42 },
      }),
    getTransactionBySessionId:
      overrides.getTransactionBySessionId ??
      vi.fn().mockResolvedValue({
        responseCode: 0,
        data: {
          status: "1",
          orderId: 42,
          sessionId: "p24-session-1",
          amount: 4999,
          currency: "PLN",
        },
      }),
  } as unknown as P24ApiService;

  return {
    p24Api,
    logger,
    findMedusaPaymentSessionId:
      overrides.findMedusaPaymentSessionId ??
      vi.fn().mockResolvedValue("payses_medusa_1"),
    buildError: (message: string, error?: unknown) =>
      new Error(
        `${message}: ${
          error instanceof Error ? error.message : String(error ?? "unknown")
        }`,
      ),
  };
};

describe("extractP24WebhookSourceIp", () => {
  it("prefers cf-connecting-ip when behind Cloudflare", () => {
    expect(
      extractP24WebhookSourceIp({
        "cf-connecting-ip": "5.252.202.254",
        "x-real-ip": "172.64.200.81",
        "x-forwarded-for": "5.252.202.254, 172.64.200.81",
      }),
    ).toBe("5.252.202.254");
  });

  it("falls back when cf-connecting-ip is whitespace", () => {
    expect(
      extractP24WebhookSourceIp({
        "cf-connecting-ip": "   ",
        "x-forwarded-for": "5.252.202.254",
      }),
    ).toBe("5.252.202.254");
  });

  it("prefers x-real-ip over x-forwarded-for", () => {
    expect(
      extractP24WebhookSourceIp({
        "x-real-ip": "5.252.202.254",
        "x-forwarded-for": "1.2.3.4, 10.0.0.1",
      }),
    ).toBe("5.252.202.254");
  });

  it("reads the first forwarded-for address", () => {
    expect(
      extractP24WebhookSourceIp({
        "x-forwarded-for": "5.252.202.254, 172.64.200.81",
      }),
    ).toBe("5.252.202.254");
  });
});

describe("processP24Webhook", () => {
  const webhookData = {
    data: WEBHOOK_PAYLOAD,
    rawData: WEBHOOK_PAYLOAD,
    headers: {
      "x-forwarded-for": "5.252.202.254",
    },
  };

  it("rejects webhooks from unauthorized IPs", async () => {
    const deps = createDeps({
      isAllowedWebhookIp: vi.fn().mockReturnValue(false),
    });

    const result = await processP24Webhook(deps, webhookData);

    expect(result.action).toBe(PaymentActions.NOT_SUPPORTED);
    expect(deps.logger.error).toHaveBeenCalled();
    expect(deps.p24Api.verifyWebhookSignature).not.toHaveBeenCalled();
  });

  it("rejects webhooks with invalid signatures", async () => {
    const deps = createDeps({
      verifyWebhookSignature: vi.fn().mockReturnValue(false),
    });

    const result = await processP24Webhook(deps, webhookData);

    expect(result.action).toBe(PaymentActions.NOT_SUPPORTED);
    expect(deps.p24Api.getTransactionBySessionId).not.toHaveBeenCalled();
  });

  it("leaves the transaction unverified when the paid amount differs from the registered one", async () => {
    const deps = createDeps();

    const result = await processP24Webhook(deps, {
      ...webhookData,
      data: { ...WEBHOOK_PAYLOAD, amount: 5091 },
    });

    expect(result.action).toBe(PaymentActions.FAILED);
    expect(result.data).toMatchObject({
      session_id: "payses_medusa_1",
      amount: 50.91,
    });
    expect(deps.p24Api.getTransactionBySessionId).not.toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("paid 5091, registered 4999"),
    );
  });

  it("reports a paid transaction without verifying it, leaving settlement to capture", async () => {
    const deps = createDeps();

    const result = await processP24Webhook(deps, webhookData);

    expect(result.action).toBe(PaymentActions.SUCCESSFUL);
    expect(result.data).toMatchObject({
      session_id: "payses_medusa_1",
      order_id: 42,
      paymentMethod: 64,
    });
    expect(deps.p24Api.verifyTransaction).not.toHaveBeenCalled();
  });

  it("reports a still-pending transaction as NOT_SUPPORTED so Medusa does not complete the cart", async () => {
    const deps = createDeps({
      getTransactionBySessionId: vi.fn().mockResolvedValue({
        responseCode: 0,
        data: { status: "0", orderId: 42, amount: 4999, currency: "PLN" },
      }),
    });

    const result = await processP24Webhook(deps, webhookData);

    expect(result.action).toBe(PaymentActions.NOT_SUPPORTED);
    expect(result.data).toMatchObject({ session_id: "payses_medusa_1" });
  });

  it.each([
    [
      "a P24 5xx",
      new P24ApiError({
        status: 503,
        statusText: "Service Unavailable",
        method: "GET",
        endpoint: "/transaction/by/sessionId/p24-session-1",
        responseText: "",
      }),
    ],
    [
      "a timeout",
      new P24RequestError({
        method: "GET",
        endpoint: "/transaction/by/sessionId/p24-session-1",
        timeoutMs: 20000,
        cause: new DOMException("timeout", "TimeoutError"),
      }),
    ],
    ["a database error", new Error("Connection terminated unexpectedly")],
  ])("rethrows %s so the event bus retries the notification", async (_, error) => {
    const deps = createDeps({
      getTransactionBySessionId: vi.fn().mockRejectedValue(error),
    });

    await expect(processP24Webhook(deps, webhookData)).rejects.toBe(error);
  });

  it("reports FAILED when P24 definitively refuses the status lookup", async () => {
    const deps = createDeps({
      getTransactionBySessionId: vi.fn().mockRejectedValue(
        new P24ApiError({
          status: 404,
          statusText: "Not Found",
          method: "GET",
          endpoint: "/transaction/by/sessionId/p24-session-1",
          responseText: JSON.stringify({ error: "Transaction not found", code: 404 }),
        }),
      ),
    });

    const result = await processP24Webhook(deps, webhookData);

    expect(result.action).toBe(PaymentActions.FAILED);
    expect(result.data).toMatchObject({ session_id: "p24-session-1", amount: 49.99 });
  });
});
