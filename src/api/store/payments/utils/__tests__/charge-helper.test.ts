import { describe, expect, it, vi } from "vitest";
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils";

import { P24ApiError } from "../../../../../utils/p24-api-error";
import {
  assertBlikChargeMatchesPaymentSession,
  handleP24Charge,
  resolveP24Provider,
  resolveP24ProviderKeyForStatus,
  resolvePaymentProviderById,
  resolvePaymentSessionIdempotencyKey,
} from "../charge-helper";
import { PaymentProviderKeys } from "../../../../../providers/przelewy24/types";

describe("resolveP24ProviderKeyForStatus", () => {
  it("parses full provider id", () => {
    expect(
      resolveP24ProviderKeyForStatus({
        provider_id: "pp_p24-cards_przelewy24",
      }),
    ).toBe(PaymentProviderKeys.P24_CARDS);
  });

  it("accepts provider key directly", () => {
    expect(
      resolveP24ProviderKeyForStatus({
        provider_key: PaymentProviderKeys.P24_VISA_MOBILE,
      }),
    ).toBe(PaymentProviderKeys.P24_VISA_MOBILE);
  });

  it("rejects conflicting provider key and provider id", () => {
    expect(() =>
      resolveP24ProviderKeyForStatus({
        provider_key: PaymentProviderKeys.P24_BLIK,
        provider_id: "pp_p24-cards_przelewy24",
      }),
    ).toThrow("Payment provider mismatch");
  });

  it("defaults to BLIK when provider is omitted", () => {
    expect(resolveP24ProviderKeyForStatus({})).toBe(
      PaymentProviderKeys.P24_BLIK,
    );
  });
});

describe("resolvePaymentSessionIdempotencyKey", () => {
  it("prefers medusa_payment_session_id when it is a non-empty string", () => {
    expect(
      resolvePaymentSessionIdempotencyKey({
        id: "payses_1",
        data: { medusa_payment_session_id: "payses_medusa" },
      }),
    ).toBe("payses_medusa");
  });

  it("falls back to payment session id for invalid values", () => {
    expect(
      resolvePaymentSessionIdempotencyKey({
        id: "payses_1",
        data: { medusa_payment_session_id: 123 },
      }),
    ).toBe("payses_1");
  });
});

describe("assertBlikChargeMatchesPaymentSession", () => {
  it("accepts matching provider and token", async () => {
    const retrievePaymentSession = vi.fn().mockResolvedValue({
      id: "payses_1",
      provider_id: "pp_p24-blik_przelewy24",
      data: { token: "tok_abc" },
    });

    const req = {
      scope: {
        resolve: vi.fn().mockReturnValue({
          retrievePaymentSession,
        }),
      },
    };

    await expect(
      assertBlikChargeMatchesPaymentSession(
        req as never,
        "payses_1",
        "tok_abc",
        "pp_p24-blik_przelewy24",
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects token mismatch", async () => {
    const req = {
      scope: {
        resolve: vi.fn().mockReturnValue({
          retrievePaymentSession: vi.fn().mockResolvedValue({
            id: "payses_1",
            provider_id: "pp_p24-blik_przelewy24",
            data: { token: "tok_expected" },
          }),
        }),
      },
    };

    await expect(
      assertBlikChargeMatchesPaymentSession(
        req as never,
        "payses_1",
        "tok_other",
        "pp_p24-blik_przelewy24",
      ),
    ).rejects.toThrow("token mismatch");
  });

  it("rejects provider mismatch", async () => {
    const req = {
      scope: {
        resolve: vi.fn().mockReturnValue({
          retrievePaymentSession: vi.fn().mockResolvedValue({
            id: "payses_1",
            provider_id: "pp_p24-blik_przelewy24",
            data: { token: "tok_abc" },
          }),
        }),
      },
    };

    await expect(
      assertBlikChargeMatchesPaymentSession(
        req as never,
        "payses_1",
        "tok_abc",
        "pp_p24-cards_przelewy24",
      ),
    ).rejects.toThrow("provider mismatch");
  });
});

describe("resolveP24Provider", () => {
  it("retrieves provider from payment module container", () => {
    const visaProvider = { queryTransactionStatus: vi.fn() };
    const retrieveProvider = vi.fn().mockReturnValue(visaProvider);

    const req = {
      scope: {
        resolve: vi.fn().mockReturnValue({
          __container__: {
            paymentProviderService: {
              retrieveProvider,
            },
          },
        }),
      },
    };

    const provider = resolveP24Provider(
      req as never,
      PaymentProviderKeys.P24_VISA_MOBILE,
    );

    expect(retrieveProvider).toHaveBeenCalledWith(
      "pp_p24-visa-mobile_przelewy24",
    );
    expect(provider).toBe(visaProvider);
  });
});

describe("handleP24Charge failure handling", () => {
  const SECRET_TOKEN = "TOKEN-SECRET-1234";

  function buildReq() {
    const logger = { error: vi.fn() };
    const updatePaymentSession = vi.fn().mockResolvedValue({});
    const paymentModule = {
      retrievePaymentSession: vi.fn().mockResolvedValue({
        id: "payses_1",
        amount: 12.34,
        currency_code: "pln",
        data: {
          session_id: "payses_1-retry",
          amount_grosze: 1234,
          token: SECRET_TOKEN,
          error_p24_code: "stale",
        },
      }),
      updatePaymentSession,
    };
    const query = {
      graph: vi.fn().mockResolvedValue({
        data: [{ payment_collection: { cart: { id: "cart_1" } } }],
      }),
    };

    const req = {
      scope: {
        resolve: vi.fn((key: string) => {
          if (key === ContainerRegistrationKeys.LOGGER) return logger;
          if (key === ContainerRegistrationKeys.QUERY) return query;
          if (key === Modules.PAYMENT) return paymentModule;
          throw new Error(`Unexpected key ${key}`);
        }),
      },
    };

    return { req, logger, updatePaymentSession };
  }

  it("logs structured context and stores P24 details on the session", async () => {
    const { req, logger, updatePaymentSession } = buildReq();
    const p24Error = new P24ApiError({
      status: 400,
      statusText: "Bad Request",
      method: "POST",
      endpoint: "/paymentMethod/blik/chargeByCode",
      responseText: JSON.stringify({
        error: `Invalid token ${SECRET_TOKEN}`,
        code: 400,
      }),
      secrets: [SECRET_TOKEN],
    });

    await expect(
      handleP24Charge({
        req: req as never,
        paymentSessionId: "payses_1",
        execute: () => Promise.reject(p24Error),
      }),
    ).rejects.toBe(p24Error);

    const expectedMessage =
      "P24 API request failed: 400 Bad Request - 400: Invalid token [REDACTED]";

    expect(logger.error).toHaveBeenCalledTimes(1);
    const logLine = logger.error.mock.calls[0][0] as string;
    expect(logLine).toContain(`[p24-charge] ${expectedMessage}`);
    expect(logLine).not.toContain(SECRET_TOKEN);
    expect(JSON.parse(logLine.split("context=")[1])).toEqual({
      payment_session_id: "payses_1",
      p24_session_id: "payses_1-retry",
      cart_id: "cart_1",
      amount_grosze: 1234,
      endpoint: "/paymentMethod/blik/chargeByCode",
      http_status: 400,
      p24_code: 400,
      p24_description: "Invalid token [REDACTED]",
    });

    const update = updatePaymentSession.mock.calls[0][0];
    expect(update.status).toBe("error");
    expect(update.data).toMatchObject({
      error_message: expectedMessage,
      error_http_status: 400,
      error_p24_code: 400,
      error_p24_description: "Invalid token [REDACTED]",
      error_endpoint: "/paymentMethod/blik/chargeByCode",
      error_session_id: "payses_1-retry",
      error_amount_grosze: 1234,
    });
    expect(typeof update.data.failed_at).toBe("string");
  });

  it("clears stale P24 fields for non-P24 errors", async () => {
    const { req, updatePaymentSession } = buildReq();

    await expect(
      handleP24Charge({
        req: req as never,
        paymentSessionId: "payses_1",
        execute: () => Promise.reject(new Error("BLIK code expired")),
      }),
    ).rejects.toThrow("BLIK code expired");

    expect(updatePaymentSession.mock.calls[0][0].data).toMatchObject({
      error_message: "BLIK code expired",
      error_http_status: null,
      error_p24_code: null,
      error_endpoint: null,
      error_amount_grosze: 1234,
    });
  });
});

describe("resolvePaymentProviderById", () => {
  it("retrieves provider by full provider id from payment module container", () => {
    const blikProvider = { queryTransactionStatus: vi.fn() };
    const retrieveProvider = vi.fn().mockReturnValue(blikProvider);

    const container = {
      resolve: vi.fn().mockReturnValue({
        __container__: {
          paymentProviderService: {
            retrieveProvider,
          },
        },
      }),
    };

    const provider = resolvePaymentProviderById(
      container as never,
      "pp_p24-blik_przelewy24",
    );

    expect(retrieveProvider).toHaveBeenCalledWith("pp_p24-blik_przelewy24");
    expect(provider).toBe(blikProvider);
  });
});
