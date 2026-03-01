import { describe, it, expect, vi, beforeEach } from "vitest";
import P24Base from "../p24-base";

vi.mock("../../services/p24-api", () => ({
  P24ApiService: class {
    registerTransaction = vi.fn();
    processRefund = vi.fn();
    getBaseRedirectURL = vi.fn().mockReturnValue("https://sandbox.przelewy24.pl/trnRequest");
  },
}));

vi.mock("@medusajs/framework/utils", () => ({
  AbstractPaymentProvider: class {
    constructor() {}
    static validateOptions() {}
  },
  isDefined: (val: unknown) => val !== undefined && val !== null,
  PaymentActions: {
    AUTHORIZED: "authorized",
    SUCCESSFUL: "successful",
    FAILED: "failed",
    PENDING: "pending",
    CANCELED: "canceled",
    NOT_SUPPORTED: "not_supported",
  },
}));

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

  constructor() {
    super({}, TEST_OPTIONS);
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
});
