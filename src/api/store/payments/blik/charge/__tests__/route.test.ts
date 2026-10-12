import { describe, expect, it, vi } from "vitest";
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils";

import { POST } from "../route";

const SESSION_ID = "payses_01M4QDQ4B1SH678JHJJC5SGCV1";

const pendingSession = (data: Record<string, unknown> = {}) => ({
  id: SESSION_ID,
  provider_id: "pp_p24-blik_przelewy24",
  status: "pending",
  amount: 672,
  currency_code: "pln",
  data: { session_id: SESSION_ID, token: "tok", amount: 672, ...data },
});

function setup({
  session = pendingSession(),
  updatePaymentSession = vi.fn().mockResolvedValue({}),
  chargeBlikPayment = vi
    .fn()
    .mockResolvedValue({ responseCode: 0, data: { orderId: 321 } }),
}: {
  session?: Record<string, unknown>;
  updatePaymentSession?: ReturnType<typeof vi.fn>;
  chargeBlikPayment?: ReturnType<typeof vi.fn>;
} = {}) {
  const events: string[] = [];
  const paymentModule = {
    retrievePaymentSession: vi.fn().mockResolvedValue(session),
    updatePaymentSession: vi.fn(async (input: Record<string, unknown>) => {
      events.push(`update:${String(input.status)}`);
      return updatePaymentSession(input);
    }),
    __container__: {
      paymentProviderService: {
        retrieveProvider: () => ({
          chargeBlikPayment: vi.fn(async (...args: unknown[]) => {
            events.push("chargeByCode");
            return chargeBlikPayment(...args);
          }),
        }),
      },
    },
  };
  const locking = {
    execute: vi.fn(async (key: string, job: () => Promise<unknown>) => {
      events.push(`lock:${key}`);
      try {
        return await job();
      } finally {
        events.push("unlock");
      }
    }),
  };
  const req = {
    body: { token: "tok", blikCode: "777123", payment_session_id: SESSION_ID },
    scope: {
      resolve: vi.fn((key: string) => {
        if (key === Modules.PAYMENT) return paymentModule;
        if (key === Modules.LOCKING) return locking;
        if (key === ContainerRegistrationKeys.LOGGER) return { error: vi.fn() };
        if (key === ContainerRegistrationKeys.QUERY) {
          return { graph: vi.fn().mockResolvedValue({ data: [] }) };
        }
        throw new Error(`Unexpected key ${key}`);
      }),
    },
  };
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

  return { req, res, events, updatePaymentSession, chargeBlikPayment };
}

describe("POST /store/payments/blik/charge", () => {
  it("reserves the token under the session lock before charging", async () => {
    const { req, res, events, updatePaymentSession } = setup();

    await POST(req as never, res as never);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(events).toEqual([
      `lock:p24-payment-session:${SESSION_ID}`,
      "update:pending",
      "chargeByCode",
      "unlock",
    ]);
    expect(updatePaymentSession.mock.calls[0][0].data).toHaveProperty(
      "charge_submitted_at",
    );
  });

  it("never reaches P24 when the reservation cannot be stored", async () => {
    const { req, res, chargeBlikPayment } = setup({
      updatePaymentSession: vi.fn().mockRejectedValue(new Error("db down")),
    });

    await POST(req as never, res as never);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(chargeBlikPayment).not.toHaveBeenCalled();
  });

  it("rejects a token that was already charged without calling P24", async () => {
    const { req, res, chargeBlikPayment, updatePaymentSession } = setup({
      session: pendingSession({
        charge_submitted_at: "2026-10-12T08:45:22.000Z",
      }),
    });

    await POST(req as never, res as never);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Payment session was already charged",
      }),
    );
    expect(updatePaymentSession).not.toHaveBeenCalled();
    expect(chargeBlikPayment).not.toHaveBeenCalled();
  });

  it("keeps the reservation when P24 rejects the charge", async () => {
    const { req, res, events } = setup({
      chargeBlikPayment: vi
        .fn()
        .mockResolvedValue({ responseCode: 28, message: "Incorrect ticket!" }),
    });

    await POST(req as never, res as never);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(events).toEqual([
      `lock:p24-payment-session:${SESSION_ID}`,
      "update:pending",
      "chargeByCode",
      "update:error",
      "unlock",
    ]);
  });
});
