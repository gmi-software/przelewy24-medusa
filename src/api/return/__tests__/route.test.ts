import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils";

import { GET } from "../route";

function setup(
  query: Record<string, unknown>,
  providers: Record<string, unknown>,
) {
  const retrieveProvider = vi.fn((providerId: string) => {
    if (!(providerId in providers)) {
      throw new Error(`Unable to retrieve the payment provider with id: ${providerId}`);
    }
    return providers[providerId];
  });
  const paymentModule = {
    listPaymentProviders: vi.fn(async ({ id }: { id: string[] }) =>
      id.filter((providerId) => providerId in providers).map((providerId) => ({ id: providerId })),
    ),
    __container__: {
      paymentProviderService: { retrieveProvider },
    },
  };
  const req = {
    query,
    scope: {
      resolve: vi.fn((key: string) => {
        if (key === Modules.PAYMENT) return paymentModule;
        if (key === ContainerRegistrationKeys.LOGGER) {
          return { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
        }
        throw new Error(`Unexpected key ${key}`);
      }),
    },
  };
  const res = { redirect: vi.fn() };

  return { req, res, retrieveProvider };
}

describe("GET /return", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not keep the customer waiting on a stuck provider lookup", async () => {
    vi.useFakeTimers();
    try {
      vi.stubEnv("FRONTEND_URL", "https://env.example.com");
      const { req, res } = setup({ sessionId: "payses_1", status: "ok" }, {});
      const paymentModule = req.scope.resolve(Modules.PAYMENT) as {
        listPaymentProviders: ReturnType<typeof vi.fn>;
      };
      paymentModule.listPaymentProviders.mockReturnValue(new Promise(() => {}));

      const pending = GET(req as never, res as never);
      await vi.advanceTimersByTimeAsync(2000);
      await pending;

      expect(res.redirect).toHaveBeenCalledWith(
        302,
        expect.stringContaining("https://env.example.com/payment/return"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares one provider lookup between returns while it is pending and after", async () => {
    vi.useFakeTimers();
    try {
      vi.stubEnv("FRONTEND_URL", "https://env.example.com");
      const { req, res } = setup({ sessionId: "payses_1", status: "ok" }, {});
      const paymentModule = req.scope.resolve(Modules.PAYMENT) as {
        listPaymentProviders: ReturnType<typeof vi.fn>;
      };
      let answer: (value: { id: string }[]) => void = () => {};
      paymentModule.listPaymentProviders.mockReturnValueOnce(
        new Promise((resolveLookup) => {
          answer = resolveLookup;
        }),
      );

      // a stalled database: both returns time out on the same query
      const first = GET(req as never, res as never);
      const second = GET(req as never, res as never);
      await vi.advanceTimersByTimeAsync(2000);
      await Promise.all([first, second]);
      // still pending well past the redirect timeout: not asked again
      await vi.advanceTimersByTimeAsync(60_000);
      const third = GET(req as never, res as never);
      await vi.advanceTimersByTimeAsync(2000);
      await third;
      expect(paymentModule.listPaymentProviders).toHaveBeenCalledTimes(1);
      answer([]);
      await vi.advanceTimersByTimeAsync(0);
      await GET(req as never, res as never);

      expect(paymentModule.listPaymentProviders).toHaveBeenCalledTimes(1);
      expect(res.redirect).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks again once a lookup failed", async () => {
    const { req, res } = setup({ sessionId: "payses_1", status: "ok" }, {});
    const paymentModule = req.scope.resolve(Modules.PAYMENT) as {
      listPaymentProviders: ReturnType<typeof vi.fn>;
    };
    paymentModule.listPaymentProviders.mockRejectedValueOnce(new Error("db down"));

    await GET(req as never, res as never);
    await GET(req as never, res as never);

    expect(paymentModule.listPaymentProviders).toHaveBeenCalledTimes(2);
  });

  it("resolves only the P24 providers the project registered", async () => {
    const { req, res, retrieveProvider } = setup(
      { sessionId: "payses_1", status: "ok" },
      {
        "pp_p24-cards_przelewy24": {
          options: { frontend_url: "https://shop.example.com" },
        },
      },
    );

    await GET(req as never, res as never);

    expect(retrieveProvider.mock.calls.map(([id]) => id)).toEqual([
      "pp_p24-cards_przelewy24",
    ]);
  });

  it("redirects to the provider's frontend_url with encoded query values", async () => {
    vi.stubEnv("FRONTEND_URL", "https://env.example.com");
    const { req, res } = setup(
      { sessionId: "payses_1&status=success", status: "ok#x" },
      {
        "pp_p24-blik_przelewy24": {
          options: { frontend_url: "https://shop.example.com" },
        },
      },
    );

    await GET(req as never, res as never);

    expect(res.redirect).toHaveBeenCalledWith(
      302,
      "https://shop.example.com/payment/return?session_id=payses_1%26status%3Dsuccess&status=ok%23x",
    );
  });

  it("falls back to FRONTEND_URL when no P24 provider is registered", async () => {
    vi.stubEnv("FRONTEND_URL", "https://env.example.com");
    const { req, res } = setup({ sessionId: "payses_1", status: "success" }, {});

    await GET(req as never, res as never);

    expect(res.redirect).toHaveBeenCalledWith(
      302,
      "https://env.example.com/payment/return?session_id=payses_1&status=success",
    );
  });
});
