import { describe, it, expect, vi, beforeEach } from "vitest";
import { BigNumber } from "@medusajs/framework/utils";
import P24Base from "../p24-base";
import { P24ApiError, P24RequestError } from "../../../../utils/p24-api-error";

vi.mock("../../services/p24-api", () => ({
  P24ApiService: class {
    registerTransaction = vi.fn();
    processRefund = vi.fn();
    getBaseRedirectURL = vi.fn().mockReturnValue("https://sandbox.przelewy24.pl/trnRequest");
    generateSign = vi.fn().mockReturnValue("test-widget-sign");
  },
}));

vi.mock("@medusajs/framework/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@medusajs/framework/utils")>();

  return {
    ...actual,
    AbstractPaymentProvider: class {
      constructor() {}
      static validateOptions() {}
    },
    isDefined: (val: unknown) => val !== undefined && val !== null,
  };
});

const TEST_OPTIONS = {
  merchant_id: "12345",
  pos_id: "12345",
  api_key: "test_api_key",
  crc: "test_crc",
  sandbox: true,
  frontend_url: "http://localhost:3000",
  backend_url: "http://localhost:9000",
};

class TestP24Provider extends P24Base {
  static identifier = "test-p24";

  get paymentIntentOptions() {
    return { channel: 16, description: "Test payment" };
  }

  protected getProviderKey(): string {
    return "test-p24";
  }

  constructor(cradle: Record<string, unknown> = {}) {
    super(cradle, TEST_OPTIONS);
  }
}

class TestP24ProviderWithThrowingQuery extends TestP24Provider {
  constructor() {
    super({
      resolve: () => {
        throw new Error("Could not resolve 'query'");
      },
    });
  }
}

describe("P24Base – amount conversion", () => {
  let provider: TestP24Provider;

  beforeEach(() => {
    provider = new TestP24Provider();
  });

  it("initiatePayment converts amount to grosze", async () => {
    const mockRegister = vi.fn().mockResolvedValue({
      responseCode: 0,
      data: { token: "test-token" },
    });
    provider["p24Api"].registerTransaction = mockRegister;

    await provider.initiatePayment({
      currency_code: "PLN",
      amount: 49.99,
      context: { idempotency_key: "session-123" },
    } as any);

    expect(mockRegister).toHaveBeenCalledOnce();
    expect(mockRegister.mock.calls[0][0].amount).toBe(4999);
  });

  it("refundPayment converts amount to grosze", async () => {
    const mockRefund = vi.fn().mockResolvedValue({
      responseCode: 0,
      data: [{ orderId: 1, status: true, message: "OK" }],
    });
    provider["p24Api"].processRefund = mockRefund;

    await provider.refundPayment({
      data: {
        session_id: "session-123",
        order_id: 1,
        currency: "PLN",
      },
      amount: 30,
      context: { idempotency_key: "refund-key-1" },
    } as any);

    expect(mockRefund).toHaveBeenCalledOnce();
    expect(mockRefund.mock.calls[0][0].refunds[0].amount).toBe(3000);
  });

  it("refundPayment converts Medusa's raw refund amount to grosze", async () => {
    const mockRefund = vi.fn().mockResolvedValue({
      responseCode: 0,
      data: [{ orderId: 1, status: true, message: "OK" }],
    });
    provider["p24Api"].processRefund = mockRefund;

    // The payment module passes `refund.raw_amount`, not a number.
    const result = await provider.refundPayment({
      data: {
        session_id: "session-123",
        order_id: 1,
        currency: "PLN",
      },
      amount: new BigNumber(30.5).raw,
      context: { idempotency_key: "refund-key-raw" },
    } as any);

    expect(mockRefund.mock.calls[0][0].refunds[0].amount).toBe(3050);
    expect(result.data?.refund_amount).toBe(30.5);
  });

  describe("refundPayment with an unknown outcome", () => {
    const refundInput = {
      data: { session_id: "session-123", order_id: 1, currency: "PLN" },
      amount: 30,
      context: { idempotency_key: "refund-key-lost" },
    } as any;
    const timedOut = () =>
      new P24RequestError({
        method: "POST",
        endpoint: "/transaction/refund",
        timeoutMs: 20_000,
        cause: Object.assign(new Error("aborted"), { name: "TimeoutError" }),
      });

    it("reports a refund P24 took although the answer never came", async () => {
      provider["p24Api"].processRefund = vi.fn().mockRejectedValue(timedOut());
      const lookup = vi.fn().mockResolvedValue({
        responseCode: 0,
        data: {
          orderId: 1,
          refunds: [
            { requestId: "other", amount: 1000, status: 0 },
            { requestId: "refund-key-lost", amount: 3000, status: 3 },
          ],
        },
      });
      provider["p24Api"].getRefundsByOrderId = lookup;

      const result = await provider.refundPayment(refundInput);

      expect(lookup).toHaveBeenCalledWith(1);
      expect(result.data?.status).toBe("refund_requested");
      expect(result.data?.refund_request_id).toBe("refund-key-lost");
    });

    it("fails when P24 holds no such request, or cannot say", async () => {
      for (const lookup of [
        vi.fn().mockResolvedValue({ data: { orderId: 1, refunds: [] } }),
        vi.fn().mockRejectedValue(new Error("P24 API request failed: 404 Not Found")),
      ]) {
        provider["p24Api"].processRefund = vi.fn().mockRejectedValue(timedOut());
        provider["p24Api"].getRefundsByOrderId = lookup;

        await expect(provider.refundPayment(refundInput)).rejects.toThrow();
      }
    });

    it("fails for a request P24 holds as rejected (status 4)", async () => {
      provider["p24Api"].processRefund = vi.fn().mockRejectedValue(timedOut());
      provider["p24Api"].getRefundsByOrderId = vi.fn().mockResolvedValue({
        data: {
          orderId: 1,
          refunds: [{ requestId: "refund-key-lost", amount: 3000, status: 4 }],
        },
      });

      await expect(provider.refundPayment(refundInput)).rejects.toThrow();
    });

    it("says the outcome is unknown when P24 cannot be asked", async () => {
      provider["p24Api"].processRefund = vi.fn().mockRejectedValue(timedOut());
      provider["p24Api"].getRefundsByOrderId = vi
        .fn()
        .mockRejectedValue(new Error("socket hang up"));

      await expect(provider.refundPayment(refundInput)).rejects.toThrow(
        /unknown outcome.*Check the P24 panel/,
      );
    });

    it("does not look anything up for a refund P24 refused", async () => {
      provider["p24Api"].processRefund = vi.fn().mockRejectedValue(
        new P24ApiError({
          status: 400,
          statusText: "Bad Request",
          method: "POST",
          endpoint: "/transaction/refund",
          responseText: "{}",
          secrets: [],
        }),
      );
      const lookup = vi.fn();
      provider["p24Api"].getRefundsByOrderId = lookup;

      await expect(provider.refundPayment(refundInput)).rejects.toThrow();
      expect(lookup).not.toHaveBeenCalled();
    });
  });

  it("refundPayment uses currency field when currency_code is missing", async () => {
    const mockRefund = vi.fn().mockResolvedValue({
      responseCode: 0,
      data: [{ orderId: 1, status: true, message: "OK" }],
    });
    provider["p24Api"].processRefund = mockRefund;

    await provider.refundPayment({
      data: {
        session_id: "session-123",
        order_id: 1,
        currency: "EUR",
      },
      amount: 30.5,
      context: { idempotency_key: "refund-key-2" },
    } as any);

    expect(mockRefund).toHaveBeenCalledOnce();
    expect(mockRefund.mock.calls[0][0].refunds[0].amount).toBe(3050);
  });

  it("refundPayment requires idempotency key", async () => {
    await expect(
      provider.refundPayment({
        data: {
          session_id: "session-123",
          order_id: 1,
          currency: "PLN",
        },
        amount: 30,
        context: {},
      } as any),
    ).rejects.toThrow("idempotency key");
  });
});

describe("P24Base – registration", () => {
  it("does not register urlCardPaymentNotification unless the provider opts in", async () => {
    const provider = new TestP24Provider();
    const mockRegister = vi.fn().mockResolvedValue({
      responseCode: 0,
      data: { token: "test-token" },
    });
    provider["p24Api"].registerTransaction = mockRegister;

    await provider.initiatePayment({
      currency_code: "PLN",
      amount: 10,
      context: { idempotency_key: "session-123" },
    } as any);

    expect(mockRegister.mock.calls[0][0]).not.toHaveProperty(
      "urlCardPaymentNotification",
    );
  });

  it("updatePayment drops the charge marker of the superseded token", async () => {
    const provider = new TestP24Provider();
    provider["p24Api"].registerTransaction = vi.fn().mockResolvedValue({
      responseCode: 0,
      data: { token: "fresh-token" },
    });

    const result = await provider.updatePayment({
      amount: 20,
      currency_code: "PLN",
      context: {},
      data: {
        session_id: "payses_SYNTHETICSESSION0000000001",
        token: "burned-token",
        amount: 10,
        charge_submitted_at: "2026-10-12T08:45:22.000Z",
      },
    } as any);

    expect(result.data?.token).toBe("fresh-token");
    expect(result.data).not.toHaveProperty("charge_submitted_at");
  });

  it("updatePayment keeps the charge marker when the registration is unchanged", async () => {
    const provider = new TestP24Provider();

    const result = await provider.updatePayment({
      amount: 10,
      currency_code: "PLN",
      context: {},
      data: {
        session_id: "payses_SYNTHETICSESSION0000000001",
        token: "tok",
        amount: 10,
        charge_submitted_at: "2026-10-12T08:45:22.000Z",
      },
    } as any);

    expect(result.data?.charge_submitted_at).toBe("2026-10-12T08:45:22.000Z");
  });

  it("updatePayment refuses to re-register a session Medusa already recorded as paid", async () => {
    const provider = new TestP24Provider();
    const register = vi.fn();
    provider["p24Api"].registerTransaction = register;

    await expect(
      provider.updatePayment({
        amount: 20,
        currency_code: "PLN",
        context: {},
        data: {
          session_id: "payses_SYNTHETICSESSION0000000001",
          token: "tok",
          amount: 10,
          p24_status: 1,
          order_id: 123456789,
        },
      } as any),
    ).rejects.toThrow("Cannot re-register a paid P24 payment session");
    expect(register).not.toHaveBeenCalled();
  });
});

describe("P24Base – authorizePayment", () => {
  const authorize = (provider: TestP24Provider, paidGrosze: number) => {
    provider["p24Api"].getTransactionBySessionId = vi.fn().mockResolvedValue({
      responseCode: 0,
      data: {
        status: 1,
        orderId: 123456789,
        sessionId: "payses_SYNTHETICSESSION0000000002",
        amount: paidGrosze,
        currency: "PLN",
      },
    });

    return provider.authorizePayment({
      data: {
        session_id: "payses_SYNTHETICSESSION0000000002",
        amount: 220,
        amount_grosze: 22000,
        currency_code: "pln",
      },
    } as any);
  };

  it("rejects a transaction whose amount differs from the registered one", async () => {
    await expect(authorize(new TestP24Provider(), 22092)).rejects.toThrow(
      "amount_mismatch: registered 22000, paid 22092",
    );
  });

  it("authorizes a transaction paid with the registered amount", async () => {
    const result = await authorize(new TestP24Provider(), 22000);

    expect(result.status).toBe("authorized");
    expect(result.data).toMatchObject({ amount: 220, amount_grosze: 22000 });
  });
});

describe("P24Base – capturePayment", () => {
  const CAPTURE_INPUT = {
    data: {
      session_id: "payses_SYNTHETICSESSION0000000002",
      amount: 220,
      currency: "PLN",
      order_id: 123456789,
    },
  } as any;

  const statusResponse = (status: number) => ({
    responseCode: 0,
    data: { status, amount: 22000, orderId: 123456789 },
  });

  const unavailable = () =>
    new P24ApiError({
      status: 503,
      statusText: "Service Unavailable",
      method: "PUT",
      endpoint: "/transaction/verify",
      responseText: "",
    });

  const providerWith = (
    statuses: Array<number | Error>,
    verify: ReturnType<typeof vi.fn>,
  ) => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const provider = new TestP24Provider({ logger });
    const byStatus = vi.fn();
    for (const status of statuses) {
      if (status instanceof Error) {
        byStatus.mockRejectedValueOnce(status);
      } else {
        byStatus.mockResolvedValueOnce(statusResponse(status));
      }
    }
    provider["p24Api"].getTransactionBySessionId = byStatus;
    provider["p24Api"].verifyTransaction = verify;
    provider["verifyRetryDelaysMs_"] = [0, 0];

    return { provider, byStatus, logger };
  };

  it("does not verify a transaction P24 already reports as verified", async () => {
    const verify = vi.fn();
    const { provider } = providerWith([2], verify);

    const result = await provider.capturePayment(CAPTURE_INPUT);

    expect(verify).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({ capture_verified: true });
  });

  it("verifies when the status lookup itself fails", async () => {
    const verify = vi.fn().mockResolvedValue({
      responseCode: 0,
      data: { status: "success" },
    });
    const { provider } = providerWith([unavailable()], verify);

    const result = await provider.capturePayment(CAPTURE_INPUT);

    expect(verify).toHaveBeenCalledTimes(1);
    expect(result.data).toMatchObject({ capture_verified: true });
  });

  it("retries a verify that got a 5xx", async () => {
    const verify = vi
      .fn()
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValueOnce({ responseCode: 0, data: { status: "success" } });
    const { provider } = providerWith([1, 1], verify);

    const result = await provider.capturePayment(CAPTURE_INPUT);

    expect(verify).toHaveBeenCalledTimes(2);
    expect(result.data).toMatchObject({ capture_verified: true });
  });

  it("treats a timed-out verify as captured once P24 reports the transaction verified", async () => {
    const verify = vi.fn().mockRejectedValue(
      new P24RequestError({
        method: "PUT",
        endpoint: "/transaction/verify",
        timeoutMs: 20000,
        cause: new DOMException("timeout", "TimeoutError"),
      }),
    );
    const { provider } = providerWith([1, 2], verify);

    const result = await provider.capturePayment(CAPTURE_INPUT);

    expect(verify).toHaveBeenCalledTimes(1);
    expect(result.data).toMatchObject({ capture_verified: true });
  });

  it("gives up after the retries and rethrows the last error", async () => {
    const error = unavailable();
    const verify = vi.fn().mockRejectedValue(error);
    const { provider } = providerWith([1, 1, 1, 1], verify);

    await expect(provider.capturePayment(CAPTURE_INPUT)).rejects.toBe(error);
    expect(verify).toHaveBeenCalledTimes(3);
  });

  it("does not retry a verification P24 refused", async () => {
    const verify = vi.fn().mockRejectedValue(
      new P24ApiError({
        status: 400,
        statusText: "Bad Request",
        method: "PUT",
        endpoint: "/transaction/verify",
        responseText: JSON.stringify({ error: "Transaction not verified", code: 400 }),
      }),
    );
    const { provider } = providerWith([1, 1], verify);

    await expect(provider.capturePayment(CAPTURE_INPUT)).rejects.toThrow(
      "400 Bad Request",
    );
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("settles the transaction by verifying it with P24", async () => {
    const provider = new TestP24Provider();
    const verify = vi.fn().mockResolvedValue({
      responseCode: 0,
      data: { status: "success" },
    });
    provider["p24Api"].verifyTransaction = verify;
    provider["p24Api"].getTransactionBySessionId = vi
      .fn()
      .mockResolvedValue(statusResponse(1));

    const result = await provider.capturePayment({
      data: {
        session_id: "payses_SYNTHETICSESSION0000000002",
        amount: 220,
        currency: "PLN",
        order_id: 123456789,
      },
    } as any);

    expect(verify).toHaveBeenCalledWith(
      "payses_SYNTHETICSESSION0000000002",
      22000,
      "PLN",
      123456789,
    );
    expect(result.data).toMatchObject({ capture_verified: true });
  });

  it("logs a refused verification as an error", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const provider = new TestP24Provider({ logger });
    provider["p24Api"].verifyTransaction = vi.fn().mockResolvedValue({
      responseCode: 1,
      data: { status: "failed" },
    });
    provider["p24Api"].getTransactionBySessionId = vi
      .fn()
      .mockResolvedValue(statusResponse(1));

    await expect(
      provider.capturePayment({
        data: {
          session_id: "payses_SYNTHETICSESSION0000000002",
          amount: 220,
          currency: "PLN",
          order_id: 123456789,
        },
      } as any),
    ).rejects.toThrow("Verification failed");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Error capturing payment payses_SYNTHETICSESSION0000000002",
      ),
    );
  });
});

describe("P24Base – findMedusaPaymentSessionId", () => {
  it("returns payses id without touching container query", async () => {
    const provider = new TestP24ProviderWithThrowingQuery();

    await expect(
      provider["findMedusaPaymentSessionId"](
        "payses_SYNTHETICSESSION0000000003",
      ),
    ).resolves.toBe("payses_SYNTHETICSESSION0000000003");
  });

  it("falls back to raw session id when query is unavailable", async () => {
    const provider = new TestP24ProviderWithThrowingQuery();

    await expect(
      provider["findMedusaPaymentSessionId"]("custom-p24-session"),
    ).resolves.toBe("custom-p24-session");
  });
});
