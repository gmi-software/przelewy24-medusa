import { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { processPaymentWorkflow } from '@medusajs/medusa/core-flows'
import { PaymentActions } from '@medusajs/framework/utils'

import { resolvePaymentProviderById, type P24TransactionStatusQueryProvider } from '../api/store/payments/utils/charge-helper'
import { getSmallestUnit } from '../utils/get-smallest-unit'
import {
  getJobErrorMessage,
  isExpectedStalePaymentJobFailure,
} from '../utils/payment-job-errors'

const P24_PROVIDER_PREFIX = 'pp_p24'
const RECONCILE_AFTER_MINUTES = 5
const RECONCILE_MAX_AGE_HOURS = 48
const RECONCILE_BATCH_SIZE = 50

const RECONCILEABLE_STATUSES = ['pending', 'requires_more', 'authorized'] as const

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

  const { data: paymentSessions } = await query.graph({
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
      'payment_collection.payments.captured_at',
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
      take: RECONCILE_BATCH_SIZE,
      order: {
        updated_at: 'DESC',
      },
    },
  })

  let reconciled = 0

  for (const session of paymentSessions ?? []) {
    const sessionData = (session.data ?? {}) as Record<string, unknown>

    if (!hasRegisteredP24Transaction(sessionData)) {
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

      const payments = session.payment_collection?.payments ?? []
      const hasCapturedPayment = payments.some(
        (payment: { captured_at?: string | null }) => Boolean(payment?.captured_at),
      )

      if (hasCapturedPayment) {
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
