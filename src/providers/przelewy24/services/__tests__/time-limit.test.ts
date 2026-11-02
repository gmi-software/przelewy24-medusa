import { describe, expect, it, vi } from "vitest";

import P24Base from "../../core/p24-base";
import { P24ApiService } from "../p24-api";
import P24BlikService from "../p24-blik";
import P24ProviderService from "../p24-provider";
import P24VisaMobileService from "../p24-visa-mobile";

const TEST_OPTIONS = {
  merchant_id: "12345",
  pos_id: "12345",
  api_key: "test_api_key",
  crc: "test_crc",
  sandbox: true,
  frontend_url: "http://localhost:3000",
  backend_url: "http://localhost:9000",
};

const INPUT = {
  currency_code: "PLN",
  amount: 100,
  context: { idempotency_key: "payses_1" },
  data: {},
};

const registerRequest = (service: P24Base) =>
  (
    service as unknown as {
      buildTransactionRequest: (
        input: typeof INPUT,
        sessionId: string,
      ) => { timeLimit?: number };
    }
  ).buildTransactionRequest(INPUT, "payses_1");

describe("redirect_time_limit_minutes", () => {
  const options = { ...TEST_OPTIONS, redirect_time_limit_minutes: 30 };

  it("limits the hosted redirect and Visa Mobile", () => {
    expect(registerRequest(new P24ProviderService({}, options)).timeLimit).toBe(
      30,
    );
    expect(
      registerRequest(new P24VisaMobileService({}, options)).timeLimit,
    ).toBe(30);
  });

  it("leaves BLIK without a limit", () => {
    expect(
      registerRequest(new P24BlikService({}, options)).timeLimit,
    ).toBeUndefined();
  });

  it("keeps P24's default when unset or 0", () => {
    expect(
      registerRequest(new P24ProviderService({}, TEST_OPTIONS)).timeLimit,
    ).toBeUndefined();
    expect(
      registerRequest(
        new P24ProviderService({}, { ...TEST_OPTIONS, redirect_time_limit_minutes: 0 }),
      ).timeLimit,
    ).toBeUndefined();
  });

  it.each([100, -1, 1.5])("refuses %s minutes", (minutes) => {
    expect(() =>
      P24Base.validateOptions({
        ...TEST_OPTIONS,
        redirect_time_limit_minutes: minutes,
      }),
    ).toThrow("redirect_time_limit_minutes");
  });

  it("sends timeLimit on register only when set", async () => {
    const api = new P24ApiService(TEST_OPTIONS);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        new Response(JSON.stringify({ data: { token: "t" }, responseCode: 0 })),
      );
    const base = {
      sessionId: "payses_1",
      amount: 10000,
      currency: "PLN",
      description: "d",
      email: "e@example.com",
      country: "PL",
    };

    await api.registerTransaction({ ...base, timeLimit: 30 });
    await api.registerTransaction(base);

    const bodies = fetchMock.mock.calls.map(
      ([, init]) => JSON.parse(String((init as RequestInit).body)),
    );
    expect(bodies[0].timeLimit).toBe(30);
    expect(bodies[1]).not.toHaveProperty("timeLimit");
    fetchMock.mockRestore();
  });
});
