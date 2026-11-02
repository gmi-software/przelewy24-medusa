import { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
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

// Per process, so a restart only re-reads the oldest pages.
let resumeFromPage = 0

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

  // Every page is read before any is processed: a reconciled session leaves
  // the window and would shift the offsets of the pages after it.
  const paymentSessions: ReconcileCandidate[] = []

  const firstPage = resumeFromPage
  resumeFromPage = 0

  for (let page = firstPage; page < firstPage + RECONCILE_MAX_PAGES; page += 1) {
    const { data } = await query.graph({
      entity: 'payment_session',
      fields: [
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
      ],
      filters: {
        provider_id: { $like: `${P24_PROVIDER_PREFIX}%` },
        status: { $in: [...RECONCILEABLE_STATUSES] },
        deleted_at: null,
        updated_at: {
          $lte: cutoff.toISOString(),
          $gte: maxAge.toISOString(),
        },
      },
      pagination: {
        skip: page * RECONCILE_PAGE_SIZE,
        take: RECONCILE_PAGE_SIZE,
        order: {
          updated_at: 'ASC',
          id: 'ASC',
        },
      },
    })

    paymentSessions.push(...((data ?? []) as ReconcileCandidate[]))

    if (!data || data.length < RECONCILE_PAGE_SIZE) {
      break
    }

    if (page === firstPage + RECONCILE_MAX_PAGES - 1) {
      resumeFromPage = page + 1
      logger.warn(
        `[p24-reconcile] Stopped after ${paymentSessions.length} payment sessions; the next run resumes at page ${resumeFromPage}`,
      )
    }
  }

  let reconciled = 0

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

      logger.error(
        `[p24-reconcile] Failed to reconcile payment session ${session.id}: ${message}`,
      )
    }
  }

  if (reconciled > 0) {
    logger.info(`[p24-reconcile] Reconciled ${reconciled} payment session(s)`)
  }
}

export const config = {
  name: 'reconcile-p24-payments',
  schedule: '*/5 * * * *',
}
