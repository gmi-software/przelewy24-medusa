import { describe, expect, it, vi } from "vitest";

import { P24ApiService } from "../p24-api";
import P24BlikService from "../p24-blik";

const TEST_OPTIONS = {
  merchant_id: "12345",
  pos_id: "12345",
  api_key: "test_api_key",
  crc: "test_crc",
  sandbox: true,
  frontend_url: "http://localhost:3000",
  backend_url: "http://localhost:9000",
};

const hashPayload = (payload: Record<string, unknown>) =>
  (
    new P24ApiService(TEST_OPTIONS) as unknown as {
      hashSignaturePayload: (data: Record<string, unknown>) => string;
    }
  ).hashSignaturePayload(payload);

describe("P24BlikService", () => {
  it("registers the additional BLIK notification URL", async () => {
    const service = new P24BlikService({}, TEST_OPTIONS);
    const registerTransaction = vi.fn().mockResolvedValue({
      responseCode: 0,
      data: { token: "blik-token" },
    });
    service["p24Api"].registerTransaction = registerTransaction;

    await service.initiatePayment({
      amount: 672,
      currency_code: "PLN",
      context: { idempotency_key: "payses_01M4QDQ4B1SH678JHJJC5SGCV1" },
    } as never);

    expect(registerTransaction.mock.calls[0][0]).toMatchObject({
      urlStatus: expect.any(String),
      urlCardPaymentNotification:
        "http://localhost:9000/hooks/p24/blik-notification",
    });
  });

  it("verifies notification signatures with the merchant CRC", () => {
    const service = new P24BlikService({}, TEST_OPTIONS);
    const signed = {
      orderId: 321,
      sessionId: "payses_01M4QDQ4B1SH678JHJJC5SGCV1",
      method: 181,
      result: { error: 28, message: "Incorrect ticket!" },
    };
    const sign = hashPayload({ ...signed, crc: TEST_OPTIONS.crc });

    expect(service.verifyBlikNotificationSignature({ ...signed, sign })).toBe(
      true,
    );
    expect(
      service.verifyBlikNotificationSignature({ ...signed, sign: "forged" }),
    ).toBe(false);
  });
});
