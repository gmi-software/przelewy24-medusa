import { describe, expect, it } from 'vitest'

import {
  getJobErrorMessage,
  isExpectedStalePaymentJobFailure,
} from '../payment-job-errors'

describe('getJobErrorMessage', () => {
  it('reads Error.message', () => {
    expect(getJobErrorMessage(new Error('boom'))).toBe('boom')
  })

  it('unwraps Error.cause', () => {
    const cause = new Error('P24 API request failed: 400 Bad Request')
    const error = new Error('Payment capture failed', { cause })

    expect(getJobErrorMessage(error)).toBe(
      'Payment capture failed: P24 API request failed: 400 Bad Request',
    )
  })

  it('reads plain-object workflow errors', () => {
    expect(
      getJobErrorMessage({
        message: 'Workflow failed',
        error: { message: 'P24 API request failed: 400 Bad Request' },
      }),
    ).toBe('Workflow failed')
  })

  it('reads nested error objects', () => {
    expect(
      getJobErrorMessage({
        error: { message: 'P24 API request failed: 404 Not Found' },
      }),
    ).toBe('P24 API request failed: 404 Not Found')
  })
})

describe('isExpectedStalePaymentJobFailure', () => {
  it('treats stale P24 API failures as expected', () => {
    expect(
      isExpectedStalePaymentJobFailure({
        error: { message: 'P24 API request failed: 400 Bad Request' },
      }),
    ).toBe(true)
  })

  it('reads a 404 response as stale, a timeout of 4040 ms as not', () => {
    expect(
      isExpectedStalePaymentJobFailure(
        new Error('P24 API request failed: 404 Not Found'),
      ),
    ).toBe(true)
    expect(
      isExpectedStalePaymentJobFailure(
        new Error('GET /transaction/by/sessionId timed out after 4040ms'),
      ),
    ).toBe(false)
  })

  it('treats unexpected failures as unexpected', () => {
    expect(
      isExpectedStalePaymentJobFailure(new Error('Delivery slot unavailable')),
    ).toBe(false)
  })
})
