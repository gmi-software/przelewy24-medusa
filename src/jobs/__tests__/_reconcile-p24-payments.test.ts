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

import reconcileP24PaymentsJob, {
  RECONCILE_READ_BUDGET_MS,
  RECONCILE_RETRY_BUDGET_MS,
  RECONCILE_RUN_BUDGET_MS,
  resetReconcileMemoryState,
} from "../reconcile-p24-payments";

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
  resetReconcileMemoryState();
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
      if (key === "locking") throw new Error("locking is not registered");
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

  it("asks P24 about a card registration whose answer never came", async () => {
    const { container } = setupPages([
      [
        candidate({
          data: {
            session_id: SESSION_ID,
            pending_card_tokenization: true,
            charge_submitted_at: minute(0),
            currency_code: "pln",
          },
        }),
      ],
    ]);

    await reconcileP24PaymentsJob(container as any);

    expect(queryTransactionStatus).toHaveBeenCalledWith(SESSION_ID);
  });

  it("reconciles an errored session only when its charge was submitted", async () => {
    const { container, graph } = setupPages([
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

    expect(graph.mock.calls[0][0].filters.status.$in).toContain("error");

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

  it("saves the state only after every session read was processed", async () => {
    const { container, caching } = setupPages([
      [candidate({ id: "payses_first" }), candidate({ id: "payses_last" })],
    ]);
    run.mockRejectedValueOnce(new Error("database went away"));

    await reconcileP24PaymentsJob(container as any);

    const runOrders = run.mock.invocationCallOrder;
    expect(runOrders).toHaveLength(2);
    expect(caching.set.mock.invocationCallOrder[0]).toBeGreaterThan(runOrders[1]);
    expect(caching.set).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { cursor: null, retry: ["payses_first"] } }),
    );
  });

  it("leaves what is left past the run budget for the next run", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { container, caching, logger } = setupPages([
        [
          candidate({ id: "payses_a" }),
          candidate({ id: "payses_b" }),
          candidate({ id: "payses_c" }),
        ],
      ]);
      // P24 so slow that the first capture spends the whole budget
      run.mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + RECONCILE_RUN_BUDGET_MS + 1);
        return {};
      });

      await reconcileP24PaymentsJob(container as any);

      expect(run).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Run budget spent"),
      );
      expect(caching.set).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: { cursor: null, retry: ["payses_b", "payses_c"] },
          options: { autoInvalidate: false },
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // A previous run that failed all 1000 sessions it read: they fill the retry list.
  const failingBacklog = (pageCount: number) => {
    const setup = setupPages(
      Array.from({ length: pageCount }, () =>
        Array.from({ length: 50 }, () => candidate({ id: "payses_down" })),
      ),
    );
    const { caching, rows } = setup;
    caching.get.mockResolvedValueOnce({
      cursor: { updated_at: rows[999].updated_at, id: rows[999].id },
      retry: rows.slice(0, 1000).map((row) => row.id),
    });
    return setup;
  };
  const failExcept = (ok: Set<string>) =>
    run.mockImplementation(async ({ input }: any) => {
      if (ok.has(input.data.session_id)) return {};
      throw new Error("database went away");
    });

  it("holds the cursor before the first failure past the retry bound", async () => {
    const { container, caching, rows } = failingBacklog(42);
    // the first ten swept rows go through, the rest fail like the retries
    failExcept(new Set(rows.slice(1000, 1010).map((row) => row.id)));

    await reconcileP24PaymentsJob(container as any);
    run.mockReset();
    run.mockResolvedValue({});

    const state = caching.set.mock.calls.at(-1)![0].data;
    expect(state.retry).toEqual(rows.slice(0, 1000).map((row) => row.id));
    expect(state.cursor).toEqual({ updated_at: rows[1009].updated_at, id: rows[1009].id });
  });

  it("moves the sweep on when the row past a held cursor fails, and reads the rest on its next pass", async () => {
    const { container, caching, rows } = failingBacklog(42);
    failExcept(new Set());

    await reconcileP24PaymentsJob(container as any);

    // the first swept row failed: holding there would read it again forever
    const state = caching.set.mock.calls.at(-1)![0].data;
    expect(state.retry).toHaveLength(1000);
    expect(state.cursor).toEqual({ updated_at: rows[1999].updated_at, id: rows[1999].id });

    // the outage is over: the sweep finishes, wraps and reaches the rest
    run.mockReset();
    run.mockResolvedValue({});
    for (let pass = 0; pass < 3; pass += 1) {
      await reconcileP24PaymentsJob(container as any);
    }
    const processed = new Set(run.mock.calls.map(([{ input }]: any) => input.data.session_id));
    expect(processed.has(rows[1000].id)).toBe(true);
    expect(processed.has(rows[1999].id)).toBe(true);
  });

  it("does not release the run lock under a renewal still in flight", async () => {
    const { container } = setupPages([[candidate()]]);
    const events: string[] = [];
    let finishRenewal = () => {};
    const locking = {
      acquire: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        // the heartbeat's renewal, still waiting when the capture returns
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolveRenewal) => {
              finishRenewal = () => {
                events.push("renewed");
                resolveRenewal();
              };
            }),
        )
        .mockResolvedValue(undefined),
      release: vi.fn(async () => {
        events.push("release");
        return true;
      }),
    };
    const resolve = container.resolve;
    container.resolve = (key: string) => (key === "locking" ? locking : resolve(key));

    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      run.mockImplementationOnce(async () => {
        await vi.advanceTimersByTimeAsync(61_000);
        // the heartbeat has called acquire by now: its renewal lands after the capture
        setTimeout(() => finishRenewal(), 0);
        return {};
      });
      await reconcileP24PaymentsJob(container as any);
    } finally {
      run.mockReset();
      run.mockResolvedValue({});
      vi.useRealTimers();
    }

    expect(events).toEqual(["renewed", "release"]);
  });

  it("uses this process's copy of the state while the cache cannot be read", async () => {
    const { container, graph, caching, rows } = setupPages(
      Array.from({ length: 21 }, capturedPage),
    );

    await reconcileP24PaymentsJob(container as any);
    caching.get.mockRejectedValueOnce(new Error("redis down"));
    graph.mockClear();
    await reconcileP24PaymentsJob(container as any);

    expect(graph.mock.calls[0][0].filters.$or[1].id.$gt).toBe(rows[999].id);
  });

  it("skips the run while another one holds the run lock", async () => {
    const { container, graph } = setupPages([[candidate()]]);
    const locking = {
      acquire: vi.fn().mockRejectedValue(new Error("Failed to acquire lock")),
      release: vi.fn(),
    };
    const resolve = container.resolve;
    container.resolve = (key: string) => (key === "locking" ? locking : resolve(key));

    await reconcileP24PaymentsJob(container as any);

    expect(graph).not.toHaveBeenCalled();
    expect(locking.release).not.toHaveBeenCalled();
  });

  it("runs under the run lock and releases it", async () => {
    const { container } = setupPages([[candidate()]]);
    const locking = { acquire: vi.fn(), release: vi.fn().mockResolvedValue(true) };
    const resolve = container.resolve;
    container.resolve = (key: string) => (key === "locking" ? locking : resolve(key));

    await reconcileP24PaymentsJob(container as any);

    expect(locking.acquire).toHaveBeenCalledWith(
      "p24-reconcile:run",
      expect.objectContaining({ expire: 900 }),
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(locking.release).toHaveBeenCalledWith(
      "p24-reconcile:run",
      { ownerId: locking.acquire.mock.calls[0][1].ownerId },
    );
  });

  it("renews the run lock while reading pages and before writing the state", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // past the page cap, so the run saves a cursor
      const { container, graph, caching } = setupPages(
        Array.from({ length: 21 }, capturedPage),
      );
      const read = graph.getMockImplementation()!;
      // every page read takes two minutes
      graph.mockImplementation(async (args: any) => {
        vi.setSystemTime(Date.now() + 2 * 60_000);
        return read(args);
      });
      const locking = {
        acquire: vi.fn().mockResolvedValue(undefined),
        release: vi.fn().mockResolvedValue(true),
      };
      const resolve = container.resolve;
      container.resolve = (key: string) => (key === "locking" ? locking : resolve(key));

      await reconcileP24PaymentsJob(container as any);

      const setOrder = caching.set.mock.invocationCallOrder.at(-1)!;
      const acquires = locking.acquire.mock.invocationCallOrder;
      // the first acquire, renewals between page reads, one right before the write
      expect(acquires.length).toBeGreaterThanOrEqual(4);
      expect(acquires.at(-1)!).toBeLessThan(setOrder);
      expect(
        graph.mock.invocationCallOrder.some(
          (order) => order > acquires[1] && order < acquires.at(-1)!,
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews the run lock as it goes and stops once it is lost", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { container, caching } = setupPages([
        [
          candidate({ id: "payses_a" }),
          candidate({ id: "payses_b" }),
          candidate({ id: "payses_c" }),
        ],
      ]);
      const locking = {
        acquire: vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("lock taken over")),
        release: vi.fn().mockResolvedValue(true),
      };
      const resolve = container.resolve;
      container.resolve = (key: string) => (key === "locking" ? locking : resolve(key));
      // each capture takes two minutes
      run.mockImplementation(async () => {
        vi.setSystemTime(Date.now() + 2 * 60_000);
        return {};
      });

      await reconcileP24PaymentsJob(container as any);

      const { ownerId } = locking.acquire.mock.calls[0][1];
      expect(locking.acquire.mock.calls.map(([, args]) => args.ownerId)).toEqual([
        ownerId,
        ownerId,
        ownerId,
      ]);
      // a, b (after renewing), then the renewal before c fails
      expect(run).toHaveBeenCalledTimes(2);
      // another run holds the sweep now: its state is not overwritten
      expect(caching.set).not.toHaveBeenCalled();
    } finally {
      run.mockReset();
      run.mockResolvedValue({});
      vi.useRealTimers();
    }
  });

  it("leaves slow retries for later so the sweep still runs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { container, caching } = setupPages([
        [
          candidate({ id: "payses_retry_1" }),
          candidate({ id: "payses_retry_2" }),
          candidate({ id: "payses_new" }),
        ],
      ]);
      await caching.set({
        key: "p24-reconcile:cursor",
        data: { cursor: null, retry: ["payses_retry_1", "payses_retry_2"] },
      });
      run.mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + RECONCILE_RETRY_BUDGET_MS + 1);
        return {};
      });

      await reconcileP24PaymentsJob(container as any);

      expect(run.mock.calls.map(([arg]) => arg.input.data.session_id)).toEqual([
        "payses_retry_1",
        "payses_new",
      ]);
      expect(caching.set).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: { cursor: null, retry: ["payses_retry_2"] },
        }),
      );

      // the next run starts with the retry that waited, on a fresh budget
      run.mockClear();
      await reconcileP24PaymentsJob(container as any);
      expect(run.mock.calls[0][0].input.data.session_id).toBe("payses_retry_2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts retries that waited ahead of those that failed again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { container, caching } = setupPages([
        [
          candidate({ id: "payses_stuck_1" }),
          candidate({ id: "payses_stuck_2" }),
          candidate({ id: "payses_paid" }),
        ],
      ]);
      await caching.set({
        key: "p24-reconcile:cursor",
        data: {
          cursor: null,
          retry: ["payses_stuck_1", "payses_stuck_2", "payses_paid"],
        },
      });
      // stuck_1 fails slowly; stuck_2 fails; paid waits for the next run
      run
        .mockImplementationOnce(async () => {
          vi.setSystemTime(Date.now() + RECONCILE_RETRY_BUDGET_MS / 2);
          throw new Error("P24 timed out");
        })
        .mockImplementationOnce(async () => {
          vi.setSystemTime(Date.now() + RECONCILE_RETRY_BUDGET_MS / 2 + 1);
          throw new Error("P24 timed out");
        });

      await reconcileP24PaymentsJob(container as any);

      expect(caching.set.mock.calls.at(-1)![0].data.retry).toEqual([
        "payses_paid",
        "payses_stuck_1",
        "payses_stuck_2",
      ]);
    } finally {
      run.mockReset();
      run.mockResolvedValue({});
      vi.useRealTimers();
    }
  });

  it("stops reading pages once the read budget is spent", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { container, graph, caching, rows } = setupPages(
        Array.from({ length: 5 }, capturedPage),
      );
      const read = graph.getMockImplementation()!;
      graph.mockImplementation(async (args: any) => {
        vi.setSystemTime(Date.now() + RECONCILE_READ_BUDGET_MS / 2 + 1);
        return read(args);
      });

      await reconcileP24PaymentsJob(container as any);

      // two pages read, the cursor after the second for the next run
      expect(graph).toHaveBeenCalledTimes(2);
      expect(caching.set.mock.calls.at(-1)![0].data.cursor).toEqual({
        updated_at: rows[99].updated_at,
        id: rows[99].id,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("still processes what it read when one read outlasts the run budget", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { container, graph } = setupPages([[candidate()]]);
      const read = graph.getMockImplementation()!;
      graph.mockImplementation(async (args: any) => {
        vi.setSystemTime(Date.now() + RECONCILE_RUN_BUDGET_MS + 1);
        return read(args);
      });

      await reconcileP24PaymentsJob(container as any);

      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps renewing the run lock while one capture waits on P24", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      const { container } = setupPages([[candidate()]]);
      const locking = {
        acquire: vi.fn().mockResolvedValue(undefined),
        release: vi.fn().mockResolvedValue(true),
      };
      const resolve = container.resolve;
      container.resolve = (key: string) => (key === "locking" ? locking : resolve(key));
      run.mockImplementationOnce(async () => {
        // three minutes inside one capture
        await vi.advanceTimersByTimeAsync(3 * 60_000);
        return {};
      });

      await reconcileP24PaymentsJob(container as any);

      // the first acquire, three heartbeats, the renewal before the state write
      expect(locking.acquire.mock.calls.length).toBeGreaterThanOrEqual(4);
      for (const [, args] of locking.acquire.mock.calls) {
        expect(args).toEqual(expect.objectContaining({ expire: 900 }));
      }
    } finally {
      run.mockReset();
      run.mockResolvedValue({});
      vi.useRealTimers();
    }
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
