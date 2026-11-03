import { describe, expect, it, vi } from "vitest";
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils";

import { POST } from "../route";
import {
  P24ApiError,
  P24RequestError,
} from "../../../../../../utils/p24-api-error";

const SESSION_ID = "payses_01M4QDQ4B1SH678JHJJC5SGCV1";

const pendingSession = (
  data: Record<string, unknown> = {},
  status = "pending",
) => ({
  id: SESSION_ID,
  provider_id: "pp_p24-cards_przelewy24",
  status,
  amount: 672,
  currency_code: "pln",
  data: {
    session_id: SESSION_ID,
    pending_card_tokenization: true,
    amount: 672,
    ...data,
  },
});

function setup({
  session = pendingSession(),
  registerWithRefId = vi.fn().mockResolvedValue({
    token: "tok-card",
    chargeScriptUrl: "https://sandbox.przelewy24.pl/whitelabel/card/javascript/tok-card",
    sessionId: SESSION_ID,
    sessionData: { session_id: SESSION_ID, token: "tok-card" },
  }),
}: {
  session?: Record<string, unknown>;
  registerWithRefId?: ReturnType<typeof vi.fn>;
} = {}) {
  const events: string[] = [];
  const updatePaymentSession = vi.fn(async () => {
    events.push("update");
    return {};
  });
  const paymentModule = {
    retrievePaymentSession: vi.fn().mockResolvedValue(session),
    updatePaymentSession,
    __container__: {
      paymentProviderService: {
        retrieveProvider: () => ({
          registerWithRefId: vi.fn(async (...args: unknown[]) => {
            events.push("register");
            return registerWithRefId(...args);
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
    body: { ref_id: "ref-1", payment_session_id: SESSION_ID },
    scope: {
      resolve: vi.fn((key: string) => {
        if (key === Modules.PAYMENT) return paymentModule;
        if (key === Modules.LOCKING) return locking;
        if (key === ContainerRegistrationKeys.LOGGER) return { error: vi.fn() };
        throw new Error(`Unexpected key ${key}`);
      }),
    },
  };
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

  return { req, res, events, updatePaymentSession, registerWithRefId };
}

describe("POST /store/payments/card/charge", () => {
  it("registers under the session lock and marks the session charged", async () => {
    const { req, res, events, updatePaymentSession } = setup();

    await POST(req as never, res as never);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(events).toEqual([
      `lock:p24-payment-session:${SESSION_ID}`,
      "register",
      "update",
      "unlock",
    ]);
    expect(updatePaymentSession.mock.calls[0][0].data).toMatchObject({
      token: "tok-card",
      pending_card_tokenization: false,
      charge_submitted_at: expect.any(String),
    });
  });

  it.each([
    ["already registered", pendingSession({ charge_submitted_at: "2026-11-02T10:00:00.000Z" })],
    ["authorized by P24", pendingSession({ p24_status: 1 })],
    ["authorized", pendingSession({}, "authorized")],
    ["captured", pendingSession({}, "captured")],
  ])("refuses a session that is %s without calling P24", async (_, session) => {
    const { req, res, registerWithRefId, updatePaymentSession } = setup({
      session,
    });

    await POST(req as never, res as never);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(registerWithRefId).not.toHaveBeenCalled();
    expect(updatePaymentSession).not.toHaveBeenCalled();
  });

  it("refuses a session of another provider", async () => {
    const { req, res, registerWithRefId } = setup({
      session: { ...pendingSession(), provider_id: "pp_p24-blik_przelewy24" },
    });

    await POST(req as never, res as never);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(registerWithRefId).not.toHaveBeenCalled();
  });

  it("leaves a refused registration retryable", async () => {
    const { req, res, updatePaymentSession } = setup({
      registerWithRefId: vi.fn().mockRejectedValue(
        new P24ApiError({
          status: 400,
          statusText: "Bad Request",
          method: "POST",
          endpoint: "/transaction/register",
          responseText: JSON.stringify({ error: "Invalid card", code: "err162" }),
        }),
      ),
    });

    await POST(req as never, res as never);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(updatePaymentSession).not.toHaveBeenCalled();
  });

  it("answers 502 and marks the session charged when the registration outcome is unknown", async () => {
    const { req, res, updatePaymentSession } = setup({
      registerWithRefId: vi.fn().mockRejectedValue(
        new P24RequestError({
          method: "POST",
          endpoint: "/transaction/register",
          timeoutMs: 20000,
          cause: new DOMException("timeout", "TimeoutError"),
        }),
      ),
    });

    await POST(req as never, res as never);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(updatePaymentSession.mock.calls[0][0].data).toHaveProperty(
      "charge_submitted_at",
    );
  });
});
