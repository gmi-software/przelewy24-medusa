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

const minute = (index: number) =>
  new Date(Date.UTC(2026, 10, 2, 8, 0) + index * 60_000).toISOString();

/**
 * Serves `rows` (oldest first) like query.graph does for the keyset filter:
 * everything after the cursor row, `take` at a time. `caching` mimics the
 * caching module unless `cache: false`.
 */
const setupPages = (
  pages: Array<Array<Record<string, unknown>>>,
  { cache = true }: { cache?: boolean } = {},
) => {
  run.mockClear();
  queryTransactionStatus.mockReset();
  queryTransactionStatus.mockResolvedValue({
    medusaStatus: "authorized",
    p24Status: 1,
    transactionDetails: { data: { amount: 22000 } },
  });

  const flat = pages.flat();
  // Pages built from one template share an id; keep ids unique like the DB.
  const rows = flat.map((row, index) => ({
    ...row,
    id:
      flat.filter((other) => other.id === row.id).length > 1
        ? `${row.id}_${index}`
        : row.id,
    updated_at: minute(index),
  }));
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const graph = vi.fn(
    async ({
      filters,
      pagination,
    }: {
      filters: {
        id?: string[];
        $or?: [
          { updated_at: { $gt: string } },
          { updated_at: string; id: { $gt: string } },
        ];
      };
      pagination?: { take: number };
    }) => {
      if (Array.isArray(filters.id)) {
        return { data: rows.filter((row) => filters.id!.includes(row.id)) };
      }
      const keyset = filters.$or;
      const after = keyset
        ? rows.filter(
            (row) =>
              row.updated_at > keyset[0].updated_at.$gt ||
              (row.updated_at === keyset[1].updated_at && row.id > keyset[1].id.$gt),
          )
        : rows;
      return { data: after.slice(0, pagination?.take ?? after.length) };
    },
  );
  const store = new Map<string, unknown>();
  const caching = {
    get: vi.fn(async ({ key }: { key: string }) => store.get(key) ?? null),
    set: vi.fn(async ({ key, data }: { key: string; data: unknown }) => {
      store.set(key, data);
    }),
  };
  const container = {
    resolve: (key: string) => {
      if (key === ContainerRegistrationKeys.LOGGER) return logger;
      if (key === "caching" || key === "cache") {
        if (cache && key === "caching") return caching;
        throw new Error(`${key} is not registered`);
      }
      return { graph };
    },
  };

  return { container, logger, graph, caching, rows };
};

describe("reconcileP24PaymentsJob paging", () => {
  it("pages through every candidate, oldest first, after the last row read", async () => {
    const fullPage = Array.from({ length: 50 }, () => candidate({ id: "payses_page0" }));
    const { container, graph, rows } = setupPages([fullPage, [candidate()]]);

    await reconcileP24PaymentsJob(container as any);

    expect(graph).toHaveBeenCalledTimes(2);
    expect(graph.mock.calls[0][0].filters.$or).toBeUndefined();
    expect(graph.mock.calls[1][0].filters.$or).toEqual([
      { updated_at: { $gt: rows[49].updated_at } },
      { updated_at: rows[49].updated_at, id: { $gt: rows[49].id } },
    ]);
    expect(graph.mock.calls[1][0].pagination).toEqual({
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

  const capturedPage = () =>
    Array.from({ length: 50 }, () =>
      candidate({ id: "payses_full", payment_collection: { payments: [{ captured_at: "x" }] } }),
    );

  it("stops at the page cap and resumes after the last session read, in the cache", async () => {
    const { container, logger, graph, caching, rows } = setupPages(
      Array.from({ length: 25 }, capturedPage),
    );

    await reconcileP24PaymentsJob(container as any);

    expect(graph).toHaveBeenCalledTimes(20);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`resumes after session ${rows[999].id}`),
    );
    expect(caching.set).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: { cursor: { updated_at: rows[999].updated_at, id: rows[999].id }, retry: [] },
      }),
    );

    graph.mockClear();
    await reconcileP24PaymentsJob(container as any);

    expect(graph.mock.calls[0][0].filters.$or[1].id.$gt).toBe(rows[999].id);
    expect(graph).toHaveBeenCalledTimes(6);
    expect(caching.set).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { cursor: null, retry: [] } }),
    );

    graph.mockClear();
    await reconcileP24PaymentsJob(container as any);

    expect(graph.mock.calls[0][0].filters.$or).toBeUndefined();
  });

  it("does not skip a session when an earlier one leaves the window between runs", async () => {
    const { container, graph, rows } = setupPages(Array.from({ length: 21 }, capturedPage));

    await reconcileP24PaymentsJob(container as any);
    // An offset would now point 1 row too far; the keyset does not care.
    rows.splice(10, 1);
    graph.mockClear();
    await reconcileP24PaymentsJob(container as any);

    const served = (await graph.mock.results[0].value).data as { id: string }[];
    expect(served[0].id).toBe(rows[999].id);
  });

  it("continues at the following row when the saved cursor row is deleted", async () => {
    const { container, graph, rows } = setupPages(Array.from({ length: 21 }, capturedPage));

    await reconcileP24PaymentsJob(container as any);
    const following = rows[1000];
    rows.splice(999, 1);
    graph.mockClear();
    await reconcileP24PaymentsJob(container as any);

    const served = (await graph.mock.results[0].value).data as { id: string }[];
    expect(served[0].id).toBe(following.id);
  });

  it("reads a session whose processing failed again next run, past the cursor", async () => {
    const pages = Array.from({ length: 21 }, capturedPage);
    pages[0][3] = candidate({ id: "payses_flaky" });
    const { container, caching, rows } = setupPages(pages);
    run.mockRejectedValueOnce(new Error("database went away"));

    await reconcileP24PaymentsJob(container as any);

    expect(caching.set).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: {
          cursor: { updated_at: rows[999].updated_at, id: rows[999].id },
          retry: ["payses_flaky"],
        },
      }),
    );

    run.mockClear();
    await reconcileP24PaymentsJob(container as any);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].input.data.session_id).toBe("payses_flaky");
    expect(caching.set).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { cursor: null, retry: [] } }),
    );
  });

  it("saves the cursor only after every session read was processed", async () => {
    const pages = Array.from({ length: 21 }, capturedPage);
    pages[0][0] = candidate({ id: "payses_paid" });
    const { container, caching } = setupPages(pages);

    await reconcileP24PaymentsJob(container as any);

    expect(run.mock.invocationCallOrder[0]).toBeLessThan(
      caching.set.mock.invocationCallOrder[0],
    );
  });

  it("reads a state saved by the previous version as a bare cursor", async () => {
    const { container, graph, caching, rows } = setupPages(
      Array.from({ length: 21 }, capturedPage),
    );
    caching.get.mockResolvedValueOnce({ updated_at: rows[999].updated_at, id: rows[999].id });

    await reconcileP24PaymentsJob(container as any);

    expect(graph.mock.calls[0][0].filters.$or).toBeUndefined();
  });

  it("keeps the cursor in memory when no cache module is registered", async () => {
    const { container, graph, rows } = setupPages(
      Array.from({ length: 21 }, capturedPage),
      { cache: false },
    );

    await reconcileP24PaymentsJob(container as any);
    graph.mockClear();
    await reconcileP24PaymentsJob(container as any);

    expect(graph.mock.calls[0][0].filters.$or[1].id.$gt).toBe(rows[999].id);
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
