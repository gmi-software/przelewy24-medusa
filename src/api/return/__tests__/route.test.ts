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
          return { info: vi.fn(), error: vi.fn() };
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
