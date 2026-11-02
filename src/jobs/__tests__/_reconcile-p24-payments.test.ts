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

const SESSION_ID = "payses_01M487PKK2DV992DQPQW8Z7ZDW";

const candidate = (overrides: Record<string, unknown> = {}) => ({
  id: SESSION_ID,
  status: "pending",
  provider_id: "pp_p24-provider_przelewy24",
  amount: 220,
  data: {
    session_id: SESSION_ID,
    token: "tok",
    amount_grosze: 22000,
    currency_code: "pln",
  },
  payment_collection: { payments: [] },
  ...overrides,
});

const setupPages = (pages: Array<Array<Record<string, unknown>>>) => {
  run.mockClear();
  queryTransactionStatus.mockReset();
  queryTransactionStatus.mockResolvedValue({
    medusaStatus: "authorized",
    p24Status: 1,
    transactionDetails: { data: { amount: 22000 } },
  });

  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const graph = vi.fn(async ({ pagination }: { pagination: { skip: number } }) => ({
    data: pages[pagination.skip / 50] ?? [],
  }));
  const container = {
    resolve: (key: string) =>
      key === ContainerRegistrationKeys.LOGGER ? logger : { graph },
  };

  return { container, logger, graph };
};

describe("reconcileP24PaymentsJob paging", () => {
  it("pages through every candidate, oldest first", async () => {
    const fullPage = Array.from({ length: 50 }, (_, index) =>
      candidate({ id: `payses_page0_${index}` }),
    );
    const { container, graph } = setupPages([fullPage, [candidate()]]);

    await reconcileP24PaymentsJob(container as any);

    expect(graph).toHaveBeenCalledTimes(2);
    expect(graph.mock.calls[1][0].pagination).toEqual({
      skip: 50,
      take: 50,
      order: { updated_at: "ASC", id: "ASC" },
    });
    expect(queryTransactionStatus).toHaveBeenCalledTimes(51);
    expect(run).toHaveBeenCalledTimes(51);
  });

  it("skips captured collections and canceled payments without asking P24", async () => {
    const { container } = setupPages([
      [
        candidate({
          id: "payses_captured",
          status: "authorized",
          payment_collection: {
            payments: [{ payment_session_id: "payses_other", captured_at: "2026-11-01" }],
          },
        }),
        candidate({
          id: "payses_canceled",
          status: "authorized",
          payment_collection: {
            payments: [{ payment_session_id: "payses_canceled", canceled_at: "2026-11-01" }],
          },
        }),
      ],
    ]);

    await reconcileP24PaymentsJob(container as any);

    expect(queryTransactionStatus).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("reconciles an errored session only when its charge was submitted", async () => {
    const { container } = setupPages([
      [
        candidate({ id: "payses_never_charged", status: "error" }),
        candidate({
          status: "error",
          data: {
            ...candidate().data,
            charge_submitted_at: "2026-11-02T10:00:00.000Z",
          },
        }),
      ],
    ]);

    await reconcileP24PaymentsJob(container as any);

    expect(queryTransactionStatus).toHaveBeenCalledTimes(1);
    expect(queryTransactionStatus).toHaveBeenCalledWith(SESSION_ID);
    expect(run).toHaveBeenCalledWith({
      input: {
        action: "captured",
        data: { session_id: SESSION_ID, amount: 220 },
      },
    });
  });

  it("stops at the page cap and resumes there on the next run", async () => {
    const fullPage = Array.from({ length: 50 }, (_, index) =>
      candidate({ id: `payses_full_${index}`, payment_collection: { payments: [{ captured_at: "x" }] } }),
    );
    const { container, logger, graph } = setupPages(
      Array.from({ length: 25 }, () => fullPage),
    );

    await reconcileP24PaymentsJob(container as any);

    expect(graph).toHaveBeenCalledTimes(20);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("resumes at page 20"),
    );

    graph.mockClear();
    await reconcileP24PaymentsJob(container as any);

    expect(graph.mock.calls[0][0].pagination.skip).toBe(1000);
    expect(graph).toHaveBeenCalledTimes(6);

    graph.mockClear();
    await reconcileP24PaymentsJob(container as any);

    expect(graph.mock.calls[0][0].pagination.skip).toBe(0);
  });
});

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
