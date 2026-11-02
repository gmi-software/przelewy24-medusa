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

/** A failure storm must not turn the retry pass into a second sweep. */
const RECONCILE_MAX_RETRIES = RECONCILE_PAGE_SIZE * 4

const EMPTY_STATE: ReconcileState = { cursor: null, retry: [] }

// Fallback when no cache module is registered; lost on restart.
let memoryState: ReconcileState = EMPTY_STATE

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
    set: (input: { key: string; data: unknown; ttl?: number }) => Promise<void>
  }>(container, Modules.CACHING)
  if (caching) {
    return {
      get: () => caching.get({ key: RECONCILE_CURSOR_KEY }),
      set: (state) =>
        caching.set({ key: RECONCILE_CURSOR_KEY, data: state, ttl }),
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
    logger.warn(`[p24-reconcile] Could not read the sweep cursor; starting from the oldest session: ${getJobErrorMessage(error)}`)
    return EMPTY_STATE
  }
}

const writeState = async (
  store: CursorStore,
  state: ReconcileState,
  logger: { warn: (m: string) => void },
) => {
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
  if (sessionData.pending_card_tokenization === true) {
    return false
  }

  return Boolean(
    sessionData.token ||
      sessionData.order_id ||
      sessionData.orderId,
  )
}

export default async function reconcileP24PaymentsJob(
  container: MedusaContainer,
) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

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
    paymentSessions.push(...((data ?? []) as ReconcileCandidate[]))
  }
  const retried = new Set(paymentSessions.map((session) => session.id))

  for (let page = 0; page < RECONCILE_MAX_PAGES; page += 1) {
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

  let reconciled = 0
  const failed: string[] = []

  for (const session of paymentSessions) {
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
    }
  }

  // Only now, with everything read also processed: a crash before this line
  // repeats the run, and a failed session is read again next run. A sweep
  // that reached the end starts from the oldest session next time.
  if (failed.length > RECONCILE_MAX_RETRIES) {
    logger.warn(
      `[p24-reconcile] ${failed.length} sessions failed; retrying the first ${RECONCILE_MAX_RETRIES}, the rest when the sweep comes round again`,
    )
  }
  const nextState: ReconcileState = {
    cursor: capped ? cursor : null,
    retry: failed.slice(0, RECONCILE_MAX_RETRIES),
  }
  if (
    nextState.cursor !== null ||
    nextState.retry.length ||
    startState.cursor !== null ||
    startState.retry.length
  ) {
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
