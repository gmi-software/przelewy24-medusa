import { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { processPaymentWorkflow } from '@medusajs/medusa/core-flows'
import { PaymentActions } from '@medusajs/framework/utils'

import { resolvePaymentProviderById, type P24TransactionStatusQueryProvider } from '../api/store/payments/utils/charge-helper'
import { getSmallestUnit } from '../utils/get-smallest-unit'
import { P24_CHARGE_SUBMITTED_AT_KEY } from '../utils/p24-session-data'
import {
  getJobErrorMessage,
  isExpectedStalePaymentJobFailure,
} from '../utils/payment-job-errors'

const P24_PROVIDER_PREFIX = 'pp_p24'
const RECONCILE_AFTER_MINUTES = 5
const RECONCILE_MAX_AGE_HOURS = 48
const RECONCILE_PAGE_SIZE = 50
// Bounds one run; the next run resumes after the last page read.
const RECONCILE_MAX_PAGES = 20

const RECONCILE_CURSOR_KEY = 'p24-reconcile:cursor'

/**
 * Where the last capped run stopped: the (updated_at, id) of the last session
 * it read. A position, not a page offset — a session reconciled in between
 * leaves the window and would shift every offset after it, skipping sessions
 * that were never read.
 */
export type ReconcileCursor = { updated_at: string; id: string }

/**
 * What the next run needs: where the sweep stopped, and the sessions whose
 * processing failed, which are read again first. Saved only after a run has
 * processed what it read, so a crash repeats the run instead of skipping it.
 */
export type ReconcileState = { cursor: ReconcileCursor | null; retry: string[] }

/**
 * One run of the sweep: every session a run read and failed is kept for the
 * next one, so failures leave the retry list only past this many at once.
 * Ids that leave the 48-hour window drop out, as the retry read filters by it.
 */
const RECONCILE_MAX_RETRIES = RECONCILE_PAGE_SIZE * RECONCILE_MAX_PAGES

const EMPTY_STATE: ReconcileState = { cursor: null, retry: [] }

// This process's copy: the store when no cache module is registered, the
// fallback when the cache cannot be read. Lost on restart.
let warnedMemoryOnly = false
let memoryState: ReconcileState = EMPTY_STATE

/** Tests only: each test starts from an empty sweep. */
export const resetReconcileMemoryState = () => {
  memoryState = EMPTY_STATE
}

type CursorStore = {
  get: () => Promise<unknown>
  set: (state: ReconcileState) => Promise<void>
}

const resolveOptional = <T extends { get: unknown; set: unknown }>(
  container: MedusaContainer,
  key: string,
): T | null => {
  try {
    const service = container.resolve<T>(key)
    return typeof service?.get === 'function' &&
      typeof service?.set === 'function'
      ? service
      : null
  } catch {
    return null
  }
}

/**
 * Keeps the cursor in the caching module (Redis in production) so a restart
 * resumes the sweep instead of starting over at the oldest session; falls
 * back to the legacy cache module, then to process memory.
 */
export const resolveCursorStore = (
  container: MedusaContainer,
): CursorStore => {
  const ttl = RECONCILE_MAX_AGE_HOURS * 60 * 60
  const caching = resolveOptional<{
    get: (input: { key: string }) => Promise<unknown>
    set: (input: {
      key: string
      data: unknown
      ttl?: number
      options?: { autoInvalidate?: boolean }
    }) => Promise<void>
  }>(container, Modules.CACHING)
  if (caching) {
    return {
      get: () => caching.get({ key: RECONCILE_CURSOR_KEY }),
      // The cursor names a payment session; auto-invalidation would drop the
      // whole state whenever that session is updated (paid, say).
      set: (state) =>
        caching.set({
          key: RECONCILE_CURSOR_KEY,
          data: state,
          ttl,
          options: { autoInvalidate: false },
        }),
    }
  }

  const cache = resolveOptional<{
    get: (key: string) => Promise<unknown>
    set: (key: string, data: unknown, ttl?: number) => Promise<void>
  }>(container, Modules.CACHE)
  if (cache) {
    return {
      get: () => cache.get(RECONCILE_CURSOR_KEY),
      set: (state) => cache.set(RECONCILE_CURSOR_KEY, state, ttl),
    }
  }

  if (!warnedMemoryOnly) {
    warnedMemoryOnly = true
    container
      .resolve(ContainerRegistrationKeys.LOGGER)
      .warn(
        '[p24-reconcile] No caching or cache module is registered: the sweep cursor lives in process memory, so a restart starts over at the oldest session',
      )
  }
  return {
    get: async () => memoryState,
    set: async (state) => {
      memoryState = state
    },
  }
}

const isCursor = (value: unknown): value is ReconcileCursor =>
  typeof (value as ReconcileCursor | null)?.updated_at === 'string' &&
  typeof (value as ReconcileCursor | null)?.id === 'string'

export const parseReconcileState = (value: unknown): ReconcileState => {
  const state = value as Partial<ReconcileState> | null
  return {
    cursor: isCursor(state?.cursor) ? state!.cursor! : null,
    retry: Array.isArray(state?.retry)
      ? state!.retry!.filter((id): id is string => typeof id === 'string')
      : [],
  }
}

const readState = async (store: CursorStore, logger: { warn: (m: string) => void }) => {
  try {
    return parseReconcileState(await store.get())
  } catch (error) {
    // The copy this process saved last: better than restarting the sweep at
    // the oldest session on every run while the cache is down.
    logger.warn(`[p24-reconcile] Could not read the sweep cursor; using this process's copy: ${getJobErrorMessage(error)}`)
    return memoryState
  }
}

const writeState = async (
  store: CursorStore,
  state: ReconcileState,
  logger: { warn: (m: string) => void },
) => {
  memoryState = state
  try {
    await store.set(state)
  } catch (error) {
    logger.warn(`[p24-reconcile] Could not save the sweep cursor: ${getJobErrorMessage(error)}`)
  }
}

const afterCursor = (cursor: ReconcileCursor | null) =>
  cursor
    ? {
        $or: [
          { updated_at: { $gt: cursor.updated_at } },
          { updated_at: cursor.updated_at, id: { $gt: cursor.id } },
        ],
      }
    : {}

const toIso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : String(value)

// `error` only with `charge_submitted_at`: a charge whose answer we lost may
// still have been paid.
const RECONCILEABLE_STATUSES = [
  'pending',
  'requires_more',
  'authorized',
  'error',
] as const

type ReconcileCandidate = {
  id: string
  status: string
  provider_id: string
  data?: Record<string, unknown> | null
  amount: number
  payment_collection?: {
    payments?: Array<{
      payment_session_id?: string | null
      captured_at?: string | null
      canceled_at?: string | null
    } | null> | null
  } | null
}

function hasRegisteredP24Transaction(
  sessionData: Record<string, unknown>,
): boolean {
  // A charge whose answer never came is stamped without a token: P24 may
  // hold a registration under the session id, so it is asked.
  if (sessionData[P24_CHARGE_SUBMITTED_AT_KEY] != null) {
    return true
  }

  if (sessionData.pending_card_tokenization === true) {
    return false
  }

  return Boolean(
    sessionData.token ||
      sessionData.order_id ||
      sessionData.orderId,
  )
}

const RECONCILE_RUN_LOCK_KEY = 'p24-reconcile:run'
/** Longer than any run; released at the end, so it only matters on a crash. */
const RECONCILE_RUN_LOCK_SECONDS = 15 * 60
/**
 * When a run stops taking sessions, counted from its start (page reads
 * included): the last one may still take a capture's worth of P24 calls
 * (about 2.5 min) after it. The run lock is renewed meanwhile, so a slower
 * run never shares the sweep with the next tick.
 */
export const RECONCILE_RUN_BUDGET_MS = 10 * 60 * 1000
/** Retried sessions get this much of the budget; the sweep keeps the rest. */
export const RECONCILE_RETRY_BUDGET_MS = RECONCILE_RUN_BUDGET_MS / 2
/**
 * Reading pages may take this much of the budget; past it the run works on
 * what it read and the next one continues after it, so slow reads cannot
 * leave no time to process anything.
 */
export const RECONCILE_READ_BUDGET_MS = RECONCILE_RUN_BUDGET_MS / 5
/** How often a run renews its lock. */
const RECONCILE_LOCK_RENEW_MS = 60 * 1000

type RunLock = {
  acquire: (key: string, args: { ownerId: string; expire: number }) => Promise<unknown>
  release: (key: string, args: { ownerId: string }) => Promise<unknown>
}

/**
 * One run at a time across workers: overlapping runs would read the same
 * state, query the same sessions and race to capture them. A run that finds
 * the lock taken skips; the next tick picks up where the other one stops.
 */
export default async function reconcileP24PaymentsJob(
  container: MedusaContainer,
) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  let locking: RunLock | null = null
  try {
    const service = container.resolve<RunLock>(Modules.LOCKING)
    locking =
      typeof service?.acquire === 'function' && typeof service?.release === 'function'
        ? service
        : null
  } catch {
    locking = null
  }

  if (!locking) {
    return reconcileOnce(container, async () => true)
  }

  const ownerId = `p24-reconcile:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  try {
    await locking.acquire(RECONCILE_RUN_LOCK_KEY, {
      ownerId,
      expire: RECONCILE_RUN_LOCK_SECONDS,
    })
  } catch (error) {
    logger.warn(
      `[p24-reconcile] Previous run still in progress; skipping this one: ${getJobErrorMessage(error)}`,
    )
    return
  }

  // The same owner acquiring again extends the lease (Redis, Postgres and the
  // in-memory provider alike); false once the lock is gone, for good, so the
  // run stops and writes nothing over the state of the run that took it.
  const lock = locking
  let renewedAt = Date.now()
  let lost = false
  // The renewal in flight, awaited before the release: one landing after it
  // would take the lock again (a fresh row with locking-postgres, which no
  // later run takes over).
  let renewing: Promise<boolean> | null = null
  const renew = async () => {
    try {
      await lock.acquire(RECONCILE_RUN_LOCK_KEY, {
        ownerId,
        expire: RECONCILE_RUN_LOCK_SECONDS,
      })
      renewedAt = Date.now()
      return true
    } catch (error) {
      logger.warn(
        `[p24-reconcile] Lost the run lock; stopping this run: ${getJobErrorMessage(error)}`,
      )
      lost = true
      return false
    }
  }
  const keepLock = async (force = false): Promise<boolean> => {
    if (lost) return false
    if (renewing) return renewing
    if (!force && Date.now() - renewedAt < RECONCILE_LOCK_RENEW_MS) return true
    renewing = renew().finally(() => {
      renewing = null
    })
    return renewing
  }

  try {
    await reconcileOnce(container, keepLock)
  } finally {
    await renewing
    // nothing renews past this point
    lost = true
    await locking
      .release(RECONCILE_RUN_LOCK_KEY, { ownerId })
      .catch((error) =>
        logger.warn(`[p24-reconcile] Could not release the run lock: ${getJobErrorMessage(error)}`),
      )
  }
}

async function reconcileOnce(
  container: MedusaContainer,
  /** Renews the run lock (now with `force`); false once it is lost. */
  keepLock: (force?: boolean) => Promise<boolean>,
) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const runStartedAt = Date.now()

  const cutoff = new Date(Date.now() - RECONCILE_AFTER_MINUTES * 60 * 1000)
  const maxAge = new Date(
    Date.now() - RECONCILE_MAX_AGE_HOURS * 60 * 60 * 1000,
  )

  // Every page is read before any is processed, and each page continues
  // after the last row of the one before (keyset), so a session reconciled
  // mid-run cannot shift a later one out of reach.
  const paymentSessions: ReconcileCandidate[] = []
  const cursorStore = resolveCursorStore(container)
  const startState = await readState(cursorStore, logger)
  let cursor = startState.cursor
  let capped = false

  const candidateFields = [
    'id',
    'status',
    'provider_id',
    'data',
    'amount',
    'updated_at',
    'deleted_at',
    'payment_collection.payments.id',
    'payment_collection.payments.payment_session_id',
    'payment_collection.payments.captured_at',
    'payment_collection.payments.canceled_at',
  ]
  const windowFilters = {
    provider_id: { $like: `${P24_PROVIDER_PREFIX}%` },
    status: { $in: [...RECONCILEABLE_STATUSES] },
    deleted_at: null,
    updated_at: {
      $lte: cutoff.toISOString(),
      $gte: maxAge.toISOString(),
    },
  }

  // Sessions a previous run failed to process: read first, whatever the
  // cursor, for as long as they stay in the window.
  if (startState.retry.length) {
    const { data } = await query.graph({
      entity: 'payment_session',
      fields: candidateFields,
      filters: { ...windowFilters, id: startState.retry },
    })
    // in the saved order: sessions deferred last time come first
    const order = new Map(startState.retry.map((id, index) => [id, index]))
    paymentSessions.push(
      ...((data ?? []) as ReconcileCandidate[]).sort(
        (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
      ),
    )
  }
  const retried = new Set(paymentSessions.map((session) => session.id))
  // Sweep order, for holding the cursor back (see the end of the run).
  const swept: (ReconcileCandidate & { updated_at?: unknown })[] = []

  for (let page = 0; page < RECONCILE_MAX_PAGES; page += 1) {
    // Nothing processed yet: a run that lost the lock just leaves.
    if (!(await keepLock())) return

    // Reads are slow: work on what was read, the next run reads on.
    if (page > 0 && Date.now() - runStartedAt > RECONCILE_READ_BUDGET_MS) {
      capped = true
      logger.warn(
        `[p24-reconcile] Read budget spent after ${paymentSessions.length} payment sessions; the next run resumes after session ${cursor?.id}`,
      )
      break
    }

    const { data } = await query.graph({
      entity: 'payment_session',
      fields: candidateFields,
      filters: {
        ...windowFilters,
        ...afterCursor(cursor),
      },
      pagination: {
        take: RECONCILE_PAGE_SIZE,
        order: {
          updated_at: 'ASC',
          id: 'ASC',
        },
      },
    })

    const rows = (data ?? []) as (ReconcileCandidate & { updated_at?: unknown })[]
    paymentSessions.push(...rows.filter((row) => !retried.has(row.id)))
    swept.push(...rows)

    if (rows.length < RECONCILE_PAGE_SIZE) {
      break
    }

    const last = rows[rows.length - 1]!
    cursor = { updated_at: toIso(last.updated_at), id: last.id }

    if (page === RECONCILE_MAX_PAGES - 1) {
      capped = true
      logger.warn(
        `[p24-reconcile] Stopped after ${paymentSessions.length} payment sessions; the next run resumes after session ${cursor.id}`,
      )
    }
  }

  // Reads count against the run budget up to their share only, so slow reads
  // still leave the sessions they read most of the run.
  const budgetStartedAt = Math.max(runStartedAt, Date.now() - RECONCILE_READ_BUDGET_MS)

  let reconciled = 0
  const failed: string[] = []
  // Retries left for later: first in line next run, so a few stuck ones
  // cannot keep pushing a paid session back until it leaves the window.
  const deferredRetries: string[] = []

  for (const [index, session] of paymentSessions.entries()) {
    // Another run holds the sweep now: it reads this state, so leave it.
    if (!(await keepLock())) return

    // Out of time: what is left counts as failed, so the retry list and the
    // held-back cursor below bring it into the next run.
    if (Date.now() - budgetStartedAt > RECONCILE_RUN_BUDGET_MS) {
      const left = paymentSessions.slice(index).map((row) => row.id)
      logger.warn(
        `[p24-reconcile] Run budget spent; leaving ${left.length} session(s) for the next run`,
      )
      failed.push(...left)
      break
    }

    // Retries come first; past their share they wait, so slow ones never keep
    // the sweep from newer sessions.
    if (
      retried.has(session.id) &&
      Date.now() - budgetStartedAt > RECONCILE_RETRY_BUDGET_MS
    ) {
      deferredRetries.push(session.id)
      continue
    }

    const sessionData = (session.data ?? {}) as Record<string, unknown>

    if (!hasRegisteredP24Transaction(sessionData)) {
      continue
    }

    if (
      session.status === 'error' &&
      sessionData[P24_CHARGE_SUBMITTED_AT_KEY] == null
    ) {
      continue
    }

    // Checked before P24 is asked: these are most of the window.
    const payments = (session.payment_collection?.payments ?? []).filter(
      (payment): payment is NonNullable<typeof payment> => Boolean(payment),
    )

    if (
      payments.some((payment) => Boolean(payment.captured_at)) ||
      payments.some(
        (payment) =>
          payment.payment_session_id === session.id &&
          Boolean(payment.canceled_at),
      )
    ) {
      continue
    }

    const p24SessionId =
      (sessionData.session_id as string | undefined) ||
      (sessionData.sessionId as string | undefined) ||
      session.id

    // A capture can wait on P24 for minutes: the lease must outlast it.
    const heartbeat = setInterval(() => {
      void keepLock(true)
    }, RECONCILE_LOCK_RENEW_MS)
    try {
      const providerId = session.provider_id as string
      const provider = resolvePaymentProviderById<P24TransactionStatusQueryProvider>(
        container,
        providerId,
      )

      const { medusaStatus, transactionDetails } =
        await provider.queryTransactionStatus(p24SessionId)

      if (medusaStatus !== 'captured' && medusaStatus !== 'authorized') {
        continue
      }

      // Session amount, not data.amount_grosze: authorization overwrites the
      // latter with the P24 amount. Left unverified, like the webhook does.
      const sessionGrosze = getSmallestUnit(
        Number(session.amount),
        String(sessionData.currency_code ?? sessionData.currency ?? 'pln'),
      )
      const paidGrosze = Number(transactionDetails.data.amount)

      if (paidGrosze !== sessionGrosze) {
        logger.warn(
          `[p24-reconcile] Skipping payment session ${session.id}: P24 amount ${paidGrosze} differs from session amount ${sessionGrosze}`,
        )
        continue
      }

      await processPaymentWorkflow(container).run({
        input: {
          action: PaymentActions.SUCCESSFUL,
          data: {
            session_id: session.id,
            amount: session.amount,
          },
        },
      })

      reconciled += 1
    } catch (error) {
      const message = getJobErrorMessage(error)

      if (isExpectedStalePaymentJobFailure(error)) {
        logger.debug(
          `[p24-reconcile] Skipping payment session ${session.id}: ${message}`,
        )
        continue
      }

      failed.push(session.id)
      logger.error(
        `[p24-reconcile] Failed to reconcile payment session ${session.id}: ${message}`,
      )
    } finally {
      clearInterval(heartbeat)
    }
  }

  // Only now, with everything read also processed: a crash before this line
  // repeats the run, and a failed session is read again next run. A sweep
  // that reached the end starts from the oldest session next time.
  // Failures past the retry bound stay reachable by holding the cursor just
  // before the first of them that the sweep read: the next run reads it
  // (and what follows) again instead of leaving it behind until a wrap.
  // A hold must move the cursor: when the first row past it fails again, the
  // sweep moves on and the rest wait for the wrap, so failing sessions never
  // keep the sweep from the ones behind them.
  const pending = [...deferredRetries, ...failed]
  const retry = pending.slice(0, RECONCILE_MAX_RETRIES)
  const omitted = new Set(pending.slice(RECONCILE_MAX_RETRIES))
  let nextCursor = capped ? cursor : null
  if (omitted.size) {
    const firstOmitted = swept.findIndex((row) => omitted.has(row.id))
    const hold = capped && firstOmitted > 0
    if (hold) {
      const before = swept[firstOmitted - 1]!
      nextCursor = { updated_at: toIso(before.updated_at), id: before.id }
    }
    logger.warn(
      `[p24-reconcile] ${pending.length} sessions left; retrying ${retry.length} directly and ${
        hold ? 're-reading the sweep from the first of the rest' : 'leaving the rest for the next pass of the sweep'
      }`,
    )
  }
  const nextState: ReconcileState = { cursor: nextCursor, retry }
  if (
    nextState.cursor !== null ||
    nextState.retry.length ||
    startState.cursor !== null ||
    startState.retry.length
  ) {
    // The state is the sweep's: only the run that still holds the lock writes it.
    if (!(await keepLock(true))) return
    await writeState(cursorStore, nextState, logger)
  }

  if (reconciled > 0) {
    logger.info(`[p24-reconcile] Reconciled ${reconciled} payment session(s)`)
  }
}

export const config = {
  name: 'reconcile-p24-payments',
  schedule: '*/5 * * * *',
}
