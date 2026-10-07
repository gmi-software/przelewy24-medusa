import { afterEach, describe, expect, it, vi } from 'vitest'

import { P24ApiError, P24ApiService } from '../p24-api'
import {
  getJobErrorMessage,
  isExpectedStalePaymentJobFailure,
} from '../../../../utils/payment-job-errors'
import {
  getP24UserFacingMessage,
  P24_ERROR_BODY_MAX_LENGTH,
} from '../../../../utils/p24-api-error'

const TEST_OPTIONS = {
  merchant_id: '12345',
  pos_id: '12345',
  api_key: 'super_secret_api_key_value',
  crc: 'super_secret_crc_value',
  sandbox: true,
}

const BLIK_TOKEN = 'TOKEN-1234-ABCD-5678'

function mockFetchResponse(status: number, statusText: string, body: string) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: () => Promise.resolve(body),
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function captureError(promise: Promise<unknown>): Promise<P24ApiError> {
  try {
    await promise
  } catch (error) {
    return error as P24ApiError
  }
  throw new Error('Expected promise to reject')
}

describe('P24ApiService error responses', () => {
  const api = new P24ApiService(TEST_OPTIONS)

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('enriches the message with P24 code and description from a JSON body', async () => {
    mockFetchResponse(
      400,
      'Bad Request',
      JSON.stringify({ error: 'Incorrect blikCode', code: 400 }),
    )

    const error = await captureError(
      api.chargeBlikByCode({ token: BLIK_TOKEN, blikCode: '777123' }),
    )

    expect(error).toBeInstanceOf(P24ApiError)
    expect(error.message).toBe(
      'P24 API request failed: 400 Bad Request - 400: Incorrect blikCode',
    )
    expect(error.status).toBe(400)
    expect(error.endpoint).toBe('/paymentMethod/blik/chargeByCode')
    expect(error.method).toBe('POST')
    expect(error.p24Code).toBe(400)
    expect(error.p24Description).toBe('Incorrect blikCode')
    expect(error.responseBody).toEqual({ error: 'Incorrect blikCode', code: 400 })
    expect(error.localizedMessage).toBeUndefined()
  })

  it('serializes field-level error details', async () => {
    mockFetchResponse(
      400,
      'Bad Request',
      JSON.stringify({ error: { amount: 'Invalid amount' }, code: 'err103' }),
    )

    const error = await captureError(
      api.registerTransaction({
        sessionId: 'payses_01ABC',
        amount: 1234,
        currency: 'PLN',
        description: 'Order',
        email: 'jan@example.com',
        country: 'PL',
        language: 'pl',
        urlReturn: 'https://shop.example/return',
        urlStatus: 'https://shop.example/status',
      } as never),
    )

    expect(error.message).toBe(
      'P24 API request failed: 400 Bad Request - err103: {"amount":"Invalid amount"}',
    )
    expect(error.endpoint).toBe('/transaction/register')
    expect(error.localizedMessage).toBe('Nieprawidłowa kwota transakcji.')
  })

  it('falls back to truncated text for non-JSON bodies', async () => {
    const html = `<html>${'x'.repeat(5000)}</html>`
    mockFetchResponse(502, 'Bad Gateway', html)

    const error = await captureError(api.getCardInfo(42))

    expect(error.message.startsWith('P24 API request failed: 502 Bad Gateway - <html>')).toBe(true)
    expect(typeof error.responseBody).toBe('string')
    expect((error.responseBody as string).length).toBeLessThanOrEqual(
      P24_ERROR_BODY_MAX_LENGTH + '…[truncated]'.length,
    )
    expect(error.responseBody as string).toMatch(/…\[truncated\]$/)
    expect(error.p24Code).toBeUndefined()
  })

  it('keeps the bare prefix when the body is empty', async () => {
    mockFetchResponse(400, 'Bad Request', '')

    const error = await captureError(api.getCardInfo(42))

    expect(error.message).toBe('P24 API request failed: 400 Bad Request')
    expect(error.responseBody).toBeUndefined()
  })

  it('strips the query string from the endpoint', async () => {
    mockFetchResponse(404, 'Not Found', '{"error":"Not found","code":404}')

    const error = await captureError(api.getPaymentMethods('pl', 1000, 'pln'))

    expect(error.endpoint).toBe('/payment/methods/pl')
  })

  it('masks secrets echoed back in JSON and text bodies', async () => {
    mockFetchResponse(
      400,
      'Bad Request',
      JSON.stringify({
        error: `Invalid token ${BLIK_TOKEN} for key ${TEST_OPTIONS.api_key}`,
        code: 400,
        token: BLIK_TOKEN,
        sign: 'abcdef0123456789',
        details: { crc: TEST_OPTIONS.crc, authorization: 'Basic Zm9vOmJhcg==' },
      }),
    )

    const error = await captureError(
      api.chargeBlikByCode({ token: BLIK_TOKEN, blikCode: '777123' }),
    )

    const serialized = JSON.stringify({
      message: error.message,
      description: error.p24Description,
      body: error.responseBody,
    })

    expect(serialized).not.toContain(BLIK_TOKEN)
    expect(serialized).not.toContain(TEST_OPTIONS.api_key)
    expect(serialized).not.toContain(TEST_OPTIONS.crc)
    expect(serialized).not.toContain('abcdef0123456789')
    expect(serialized).not.toContain('Zm9vOmJhcg==')
    expect(error.message).toBe(
      'P24 API request failed: 400 Bad Request - 400: Invalid token [REDACTED] for key [REDACTED]',
    )
  })

  it('masks Authorization headers and key=value secrets in text bodies', async () => {
    mockFetchResponse(
      500,
      'Internal Server Error',
      'Authorization: Basic MTIzNDU6c2VjcmV0 token=abc123secret&x=1',
    )

    const error = await captureError(api.getCardInfo(1))

    expect(error.message).not.toContain('MTIzNDU6c2VjcmV0')
    expect(error.message).not.toContain('abc123secret')
    expect(error.message).toContain('Basic [REDACTED]')
    expect(error.message).toContain('token=[REDACTED]')
  })

  it('masks secret-like keys and key=value pairs beyond exact names', async () => {
    mockFetchResponse(
      400,
      'Bad Request',
      JSON.stringify({
        error: 'Rejected access_token=at-secret-1 refresh-token: rt-secret-2',
        code: 400,
        data: { access_token: 'at-secret-3', cardToken: 'ct-secret-4', clientSecret: 'cs-5' },
        raw: '{"access_token":"at-secret-6"}',
      }),
    )

    const error = await captureError(api.getCardInfo(1))

    const serialized = JSON.stringify({
      message: error.message,
      description: error.p24Description,
      body: error.responseBody,
    })

    for (const secret of ['at-secret-1', 'rt-secret-2', 'at-secret-3', 'ct-secret-4', 'cs-5', 'at-secret-6']) {
      expect(serialized).not.toContain(secret)
    }
    expect(error.p24Description).toBe(
      'Rejected access_token=[REDACTED] refresh-token: [REDACTED]',
    )
  })

  it('stays detectable as an expected stale payment job failure', async () => {
    mockFetchResponse(
      400,
      'Bad Request',
      JSON.stringify({ error: 'Transaction not verified', code: 400 }),
    )

    const error = await captureError(
      api.verifyTransaction('payses_01ABC', 1000, 'PLN', 123),
    )

    expect(error.message.startsWith('P24 API request failed: 400 Bad Request')).toBe(true)
    expect(isExpectedStalePaymentJobFailure(error)).toBe(true)
    expect(getJobErrorMessage(error)).toBe(error.message)
  })

  it('returns parsed JSON for successful responses', async () => {
    mockFetchResponse(200, 'OK', JSON.stringify({ data: { token: 't' }, responseCode: 0 }))

    await expect(api.getCardInfo(1)).resolves.toEqual({
      data: { token: 't' },
      responseCode: 0,
    })
  })
})

describe('getP24UserFacingMessage', () => {
  const api = new P24ApiService(TEST_OPTIONS)

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the localized message for known P24 codes', async () => {
    mockFetchResponse(
      400,
      'Bad Request',
      JSON.stringify({ error: { amount: 'Invalid amount' }, code: 'err103' }),
    )

    const error = await captureError(api.getCardInfo(1))

    expect(getP24UserFacingMessage(error, 'fallback')).toBe(
      'Nieprawidłowa kwota transakcji.',
    )
  })

  it('returns only the status line for unknown P24 codes', async () => {
    mockFetchResponse(
      400,
      'Bad Request',
      JSON.stringify({ error: 'Incorrect blikCode', code: 400 }),
    )

    const error = await captureError(
      api.chargeBlikByCode({ token: BLIK_TOKEN, blikCode: '777123' }),
    )

    expect(getP24UserFacingMessage(error, 'fallback')).toBe(
      'P24 API request failed: 400 Bad Request',
    )
  })

  it('does not expose non-JSON upstream bodies', async () => {
    mockFetchResponse(502, 'Bad Gateway', '<html>proxy sessionId=payses_01ABC</html>')

    const error = await captureError(api.getCardInfo(1))

    expect(error.message).toContain('<html>')
    expect(getP24UserFacingMessage(error, 'fallback')).toBe(
      'P24 API request failed: 502 Bad Gateway',
    )
  })

  it('keeps messages of other errors and falls back for non-errors', () => {
    expect(getP24UserFacingMessage(new Error('Session not found'), 'fallback')).toBe(
      'Session not found',
    )
    expect(getP24UserFacingMessage('boom', 'fallback')).toBe('fallback')
  })
})
