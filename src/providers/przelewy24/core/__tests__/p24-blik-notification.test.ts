import { describe, expect, it, vi } from "vitest";

import {
  classifyP24BlikNotification,
  handleP24BlikNotification,
  parseP24BlikNotification,
  type P24BlikNotificationDeps,
} from "../p24-blik-notification";

const PAYMENT_SESSION_ID = "payses_01M4QDQ4B1SH678JHJJC5SGCV1";
const BLIK_PROVIDER_ID = "pp_p24-blik_przelewy24";

const rejection = (overrides: Record<string, unknown> = {}) => ({
  data: {
    orderId: 321,
    sessionId: PAYMENT_SESSION_ID,
    method: 181,
    result: { error: 28, message: "Incorrect ticket!", status: "", trxRef: "" },
    ...overrides,
  },
  sign: "signature",
});

const pendingSession = (overrides: Record<string, unknown> = {}) => ({
  id: PAYMENT_SESSION_ID,
  provider_id: BLIK_PROVIDER_ID,
  status: "pending",
  data: { session_id: PAYMENT_SESSION_ID, token: "tok" },
  ...overrides,
});

const buildDeps = (
  overrides: Partial<P24BlikNotificationDeps> = {},
): P24BlikNotificationDeps => ({
  isAllowedSource: vi.fn().mockReturnValue(true),
  verifySignature: vi.fn().mockReturnValue(true),
  queryTransactionStatus: vi.fn().mockResolvedValue({ medusaStatus: "pending" }),
  retrievePaymentSession: vi.fn().mockResolvedValue(pendingSession()),
  markFailed: vi.fn().mockResolvedValue(undefined),
  withSessionLock: vi.fn((_id: string, job: () => Promise<unknown>) => job()) as P24BlikNotificationDeps["withSessionLock"],
  warn: vi.fn(),
  ...overrides,
});

describe("parseP24BlikNotification", () => {
  it("reads the documented data envelope", () => {
    expect(parseP24BlikNotification(rejection())).toEqual({
      orderId: 321,
      sessionId: PAYMENT_SESSION_ID,
      method: 181,
      result: {
        error: 28,
        message: "Incorrect ticket!",
        status: "",
        trxRef: "",
      },
      sign: "signature",
    });
  });

  it("reads a flat body and a JSON string body", () => {
    const flat = { ...rejection().data, sign: "signature" };

    expect(parseP24BlikNotification(flat)?.sessionId).toBe(PAYMENT_SESSION_ID);
    expect(parseP24BlikNotification(JSON.stringify(rejection()))?.sign).toBe(
      "signature",
    );
  });

  it("rejects incomplete or malformed payloads", () => {
    expect(parseP24BlikNotification("not json")).toBeNull();
    expect(parseP24BlikNotification(null)).toBeNull();
    expect(parseP24BlikNotification({ data: { sessionId: "x" } })).toBeNull();
    expect(
      parseP24BlikNotification({ ...rejection(), sign: undefined }),
    ).toBeNull();
    expect(
      parseP24BlikNotification(rejection({ result: "28" })),
    ).toBeNull();
  });
});

describe("classifyP24BlikNotification", () => {
  it("treats error 0 as success in any encoding", () => {
    expect(classifyP24BlikNotification({ error: 0 })).toBe("success");
    expect(classifyP24BlikNotification({ error: "0" })).toBe("success");
  });

  it("treats any other error code as failure", () => {
    expect(classifyP24BlikNotification({ error: 28 })).toBe("failure");
    expect(classifyP24BlikNotification({ error: "51" })).toBe("failure");
  });

  it("lets the transaction status override the error code", () => {
    expect(classifyP24BlikNotification({ error: 28, status: "PENDING" })).toBe(
      "unknown",
    );
    expect(
      classifyP24BlikNotification({ error: "", status: "pending" }),
    ).toBe("unknown");
    expect(
      classifyP24BlikNotification({ error: 0, status: "DECLINED", message: "USER_TIMEOUT" }),
    ).toBe("failure");
    expect(classifyP24BlikNotification({ error: 5, status: "AUTHORIZED" })).toBe(
      "success",
    );
    expect(classifyP24BlikNotification({ error: 28, status: "" })).toBe(
      "failure",
    );
  });

  it("does not guess when the error code is missing", () => {
    expect(classifyP24BlikNotification({})).toBe("unknown");
    expect(classifyP24BlikNotification({ error: "" })).toBe("unknown");
  });
});

describe("handleP24BlikNotification", () => {
  const run = (deps: P24BlikNotificationDeps, body: unknown = rejection()) =>
    handleP24BlikNotification(deps, { body, sourceIp: "91.216.191.181" });

  it("marks the pending BLIK session failed on a signed rejection", async () => {
    const deps = buildDeps();

    await expect(run(deps)).resolves.toEqual({
      kind: "marked_failed",
      paymentSessionId: PAYMENT_SESSION_ID,
    });
    expect(deps.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: PAYMENT_SESSION_ID }),
      expect.objectContaining({ sessionId: PAYMENT_SESSION_ID }),
    );
  });

  it("maps a suffixed P24 session id back to the Medusa session", async () => {
    const p24SessionId = `${PAYMENT_SESSION_ID}-6f1c2a4e-2b8d-4c1e-9a3f-1d2e3f4a5b6c`;
    const deps = buildDeps({
      retrievePaymentSession: vi.fn().mockResolvedValue(
        pendingSession({ data: { session_id: p24SessionId } }),
      ),
    });

    await expect(
      run(deps, rejection({ sessionId: p24SessionId })),
    ).resolves.toMatchObject({ kind: "marked_failed" });
    expect(deps.retrievePaymentSession).toHaveBeenCalledWith(PAYMENT_SESSION_ID);
  });

  it("rejects invalid payloads, foreign sources and bad signatures", async () => {
    await expect(run(buildDeps(), { foo: "bar" })).resolves.toMatchObject({
      kind: "rejected",
      httpStatus: 400,
    });

    const foreign = buildDeps({ isAllowedSource: vi.fn().mockReturnValue(false) });
    await expect(run(foreign)).resolves.toMatchObject({
      kind: "rejected",
      httpStatus: 403,
    });
    expect(foreign.verifySignature).not.toHaveBeenCalled();

    const forged = buildDeps({ verifySignature: vi.fn().mockReturnValue(false) });
    await expect(run(forged)).resolves.toMatchObject({
      kind: "rejected",
      httpStatus: 403,
    });
    expect(forged.retrievePaymentSession).not.toHaveBeenCalled();
  });

  it("waits while the payment is still pending in the banking app", async () => {
    const deps = buildDeps();

    await expect(
      run(deps, rejection({ result: { error: 28, status: "PENDING" } })),
    ).resolves.toMatchObject({ kind: "ignored" });
    expect(deps.markFailed).not.toHaveBeenCalled();
  });

  it("leaves successful notifications to the urlStatus flow", async () => {
    const deps = buildDeps();

    await expect(
      run(deps, rejection({ result: { error: 0, status: "AUTHORIZED" } })),
    ).resolves.toMatchObject({ kind: "ignored" });
    expect(deps.retrievePaymentSession).not.toHaveBeenCalled();
    expect(deps.markFailed).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown session", { retrievePaymentSession: vi.fn().mockRejectedValue(new Error("not found")) }],
    ["another provider", { retrievePaymentSession: vi.fn().mockResolvedValue(pendingSession({ provider_id: "pp_p24-cards_przelewy24" })) }],
    ["a superseded registration", { retrievePaymentSession: vi.fn().mockResolvedValue(pendingSession({ data: { session_id: `${PAYMENT_SESSION_ID}-newer` } })) }],
    ["an authorized session", { retrievePaymentSession: vi.fn().mockResolvedValue(pendingSession({ status: "authorized" })) }],
    ["a session already failed", { retrievePaymentSession: vi.fn().mockResolvedValue(pendingSession({ status: "error" })) }],
    ["a transaction P24 reports paid", { queryTransactionStatus: vi.fn().mockResolvedValue({ medusaStatus: "authorized" }) }],
  ])("ignores %s", async (_label, overrides) => {
    const deps = buildDeps(overrides as Partial<P24BlikNotificationDeps>);

    await expect(run(deps)).resolves.toMatchObject({ kind: "ignored" });
    expect(deps.markFailed).not.toHaveBeenCalled();
  });

  it("ignores session ids that are not Medusa payment sessions", async () => {
    const deps = buildDeps();

    await expect(
      run(deps, rejection({ sessionId: "external-session" })),
    ).resolves.toMatchObject({ kind: "ignored" });
    expect(deps.retrievePaymentSession).not.toHaveBeenCalled();
  });

  it("reads and writes the session under the payment session lock", async () => {
    const order: string[] = [];
    const deps = buildDeps({
      withSessionLock: (async (id: string, job: () => Promise<unknown>) => {
        order.push(`lock:${id}`);
        const result = await job();
        order.push("unlock");
        return result;
      }) as P24BlikNotificationDeps["withSessionLock"],
      retrievePaymentSession: vi.fn(async () => {
        order.push("retrieve");
        return pendingSession();
      }) as never,
      markFailed: vi.fn(async () => {
        order.push("markFailed");
      }),
    });

    await run(deps);

    expect(order).toEqual([
      `lock:${PAYMENT_SESSION_ID}`,
      "retrieve",
      "retrieve",
      "markFailed",
      "unlock",
    ]);
  });

  it("re-checks the session after the P24 status query", async () => {
    const deps = buildDeps({
      retrievePaymentSession: vi
        .fn()
        .mockResolvedValueOnce(pendingSession())
        .mockResolvedValueOnce(pendingSession({ status: "authorized" })),
      queryTransactionStatus: vi.fn().mockRejectedValue(new Error("timeout")),
    });

    await expect(run(deps)).resolves.toEqual({
      kind: "ignored",
      reason: "session already authorized",
    });
    expect(deps.markFailed).not.toHaveBeenCalled();
  });

  it("does not take the lock for unsigned or foreign notifications", async () => {
    const deps = buildDeps({ verifySignature: vi.fn().mockReturnValue(false) });

    await run(deps);

    expect(deps.withSessionLock).not.toHaveBeenCalled();
  });

  it("trusts the signed rejection when the P24 status check fails", async () => {
    const deps = buildDeps({
      queryTransactionStatus: vi.fn().mockRejectedValue(new Error("timeout")),
    });

    await expect(run(deps)).resolves.toMatchObject({ kind: "marked_failed" });
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("timeout"));
  });

  it("propagates persistence failures so P24 retries the notification", async () => {
    const deps = buildDeps({
      markFailed: vi.fn().mockRejectedValue(new Error("db down")),
    });

    await expect(run(deps)).rejects.toThrow("db down");
  });
});
