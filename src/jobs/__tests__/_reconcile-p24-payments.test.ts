import { describe, expect, it, vi } from "vitest";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

const run = vi.fn().mockResolvedValue({});
const queryTransactionStatus = vi.fn();

vi.mock("@medusajs/medusa/core-flows", () => ({
  processPaymentWorkflow: () => ({ run }),
}));

vi.mock("../../api/store/payments/utils/charge-helper", () => ({
  resolvePaymentProviderById: () => ({ queryTransactionStatus }),
}));

import reconcileP24PaymentsJob from "../reconcile-p24-payments";

const setup = (paidGrosze: number) => {
  run.mockClear();
  queryTransactionStatus.mockResolvedValue({
    medusaStatus: "authorized",
    p24Status: 1,
    transactionDetails: { data: { amount: paidGrosze } },
  });

  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const query = {
    graph: vi.fn().mockResolvedValue({
      data: [
        {
          id: "payses_01M487PKK2DV992DQPQW8Z7ZDW",
          status: "pending",
          provider_id: "pp_p24-provider_przelewy24",
          amount: 220,
          data: {
            session_id: "payses_01M487PKK2DV992DQPQW8Z7ZDW",
            token: "tok",
            amount_grosze: 22000,
            currency_code: "pln",
          },
          payment_collection: { payments: [] },
        },
      ],
    }),
  };
  const container = {
    resolve: (key: string) =>
      key === ContainerRegistrationKeys.LOGGER ? logger : query,
  };

  return { container, logger };
};

describe("reconcileP24PaymentsJob", () => {
  it("skips a transaction whose P24 amount differs from the session amount", async () => {
    const { container, logger } = setup(22092);

    await reconcileP24PaymentsJob(container as any);

    expect(run).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("P24 amount 22092 differs from session amount 22000"),
    );
  });

  it("processes a transaction paid with the session amount", async () => {
    const { container } = setup(22000);

    await reconcileP24PaymentsJob(container as any);

    expect(run).toHaveBeenCalledWith({
      input: {
        action: "captured",
        data: { session_id: "payses_01M487PKK2DV992DQPQW8Z7ZDW", amount: 220 },
      },
    });
  });
});
