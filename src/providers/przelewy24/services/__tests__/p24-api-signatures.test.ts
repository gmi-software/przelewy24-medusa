import { describe, expect, it } from 'vitest'

import { P24ApiService } from '../p24-api'

const TEST_OPTIONS = {
  merchant_id: '12345',
  pos_id: '12345',
  api_key: 'test_api_key',
  crc: 'test_crc_key_for_signatures',
  sandbox: true,
}

describe('P24ApiService signatures', () => {
  const api = new P24ApiService(TEST_OPTIONS)

  const hashPayload = (payload: Record<string, unknown>) =>
    (api as unknown as { hashSignaturePayload: (data: Record<string, unknown>) => string })
      .hashSignaturePayload(payload)

  it('verifies webhook notification signature', () => {
    const payload = {
      sessionId: 'session-1',
      amount: 1000,
      originAmount: 1000,
      currency: 'PLN',
      orderId: 99,
      methodId: 64,
      statement: 'order',
    }

    const sign = hashPayload({
      merchantId: 12345,
      posId: 12345,
      ...payload,
      crc: TEST_OPTIONS.crc,
    })

    expect(api.verifyWebhookSignature(payload, sign)).toBe(true)
    expect(api.verifyWebhookSignature(payload, 'invalid-sign')).toBe(false)
  })

  it('verifies card success notification signature', () => {
    const payload = {
      sessionId: 'session-card',
      amount: 2500,
      currency: 'PLN',
      orderId: 100,
      refId: 'ref-1',
      bin: '411111',
      mask: '411111******1111',
      cardType: 'visa',
      cardDate: '12/30',
      hash: 'card-hash',
    }

    const sign = hashPayload({
      merchantId: 12345,
      posId: 12345,
      sessionId: payload.sessionId,
      orderId: payload.orderId,
      amount: payload.amount,
      currency: payload.currency,
      refId: payload.refId,
      bin: payload.bin,
      mask: payload.mask,
      cardType: payload.cardType,
      cardDate: payload.cardDate,
      hash: payload.hash,
      crc: TEST_OPTIONS.crc,
    })

    expect(
      api.verifyCardPaymentNotificationSignature(payload, sign, false),
    ).toBe(true)
  })

  it('verifies additional BLIK notification signature', () => {
    const payload = {
      orderId: 321,
      sessionId: 'payses_01M4QDQ4B1SH678JHJJC5SGCV1',
      method: 181,
      result: { error: 28, message: 'Incorrect ticket!', status: '', trxRef: '' },
    }

    const sign = hashPayload({ ...payload, crc: TEST_OPTIONS.crc })

    expect(api.verifyBlikNotificationSignature(payload, sign)).toBe(true)
    expect(
      api.verifyBlikNotificationSignature(
        { ...payload, result: { ...payload.result, error: 0 } },
        sign,
      ),
    ).toBe(false)
    expect(api.verifyBlikNotificationSignature(payload, 'invalid-sign')).toBe(false)
  })

  it('allows sandbox localhost webhook IPs', () => {
    expect(api.isAllowedWebhookIp('127.0.0.1')).toBe(true)
    expect(api.isAllowedWebhookIp('203.0.113.1')).toBe(false)
  })

  it('generates card tokenization iframe sign', () => {
    const sign = api.generateCardTokenizationSign('session-card-2')

    expect(sign).toHaveLength(96)
    expect(sign).toBe(
      hashPayload({
        merchantId: 12345,
        sessionId: 'session-card-2',
        crc: TEST_OPTIONS.crc,
      }),
    )
  })
})
