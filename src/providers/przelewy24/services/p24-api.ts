import crypto from "crypto";
import {
  P24BlikChargeByCodeData,
  P24CardChargeResponse,
  P24CardInfoResponse,
  P24CardPaymentNotificationPayload,
  P24Options,
  P24PaymentMethodsResponse,
  P24RefundRequestData,
  P24RefundResponseData,
  P24SignatureData,
  P24SignatureVerificationData,
  P24Transaction,
  P24TransactionBySessionIdResponse,
  P24TransactionResponse,
  P24VerificationResponse,
  P24WebhookPayload,
} from "../types";
import { coerceSandbox } from "../../../utils/coerce-sandbox";
import { P24ApiError } from "../../../utils/p24-api-error";
import { isAllowedP24WebhookSourceIp } from "../../../utils/p24-webhook-ips";

export { P24ApiError };

export class P24ApiService {
  private readonly options: P24Options;
  private readonly baseURL: string;

  constructor(options: P24Options) {
    this.options = {
      ...options,
      sandbox: coerceSandbox(options.sandbox),
    };
    this.baseURL = this.options.sandbox
      ? "https://sandbox.przelewy24.pl/api/v1"
      : "https://secure.przelewy24.pl/api/v1";
  }

  getBaseURL(): string {
    return this.baseURL;
  }

  /**
   * Register a new transaction with P24
   */
  async registerTransaction(
    data: P24Transaction,
  ): Promise<P24TransactionResponse> {
    const requestData: Record<string, unknown> = {
      merchantId: parseInt(this.options.merchant_id),
      posId: parseInt(this.options.pos_id),
      sessionId: data.sessionId,
      amount: data.amount,
      currency: data.currency,
      description: data.description,
      email: data.email,
      country: data.country,
      language: data.language,
      urlReturn: data.urlReturn,
      urlStatus: data.urlStatus,
      sign: this.generateSign({
        sessionId: data.sessionId,
        merchantId: parseInt(this.options.merchant_id),
        amount: data.amount,
        currency: data.currency,
        crc: this.options.crc,
      }),
    };

    if (data.channel != null && data.channel > 0) {
      requestData.channel = data.channel;
    }

    if (data.method != null) {
      requestData.method = data.method;
    }

    if (data.regulationAccept === true) {
      requestData.regulationAccept = true;
    }

    if (data.cardData) {
      requestData.cardData = data.cardData;
    }

    if (data.additional) {
      requestData.additional = data.additional;
    }

    return this.makeRequest("/transaction/register", "POST", requestData);
  }

  /**
   * Verify a transaction with P24
   */
  async verifyTransaction(
    sessionId: string,
    amount: number,
    currency: string,
    orderId: number,
  ): Promise<P24VerificationResponse> {
    const data = {
      merchantId: parseInt(this.options.merchant_id),
      posId: parseInt(this.options.pos_id),
      sessionId,
      amount,
      currency,
      orderId,
      sign: this.generateVerificationSign({
        sessionId,
        orderId,
        amount,
        currency,
        crc: this.options.crc,
      }),
    };

    return this.makeRequest("/transaction/verify", "PUT", data);
  }

  /**
   * List available payment methods for amount/currency.
   */
  async getPaymentMethods(
    lang: string,
    amountGrosze: number,
    currency: string,
  ): Promise<P24PaymentMethodsResponse> {
    const params = new URLSearchParams({
      amount: String(Math.max(0, Math.trunc(amountGrosze))),
      currency: currency.toUpperCase(),
    });

    return this.makeRequest(
      `/payment/methods/${encodeURIComponent(lang.toLowerCase())}?${params.toString()}`,
      "GET",
    );
  }

  /**
   * Get transaction details by session ID
   */
  async getTransactionBySessionId(
    sessionId: string,
  ): Promise<P24TransactionBySessionIdResponse> {
    const endpoint = `/transaction/by/sessionId/${encodeURIComponent(sessionId)}`;
    return this.makeRequest(endpoint, "GET");
  }

  /**
   * Process a refund
   */
  async processRefund(
    refundData: P24RefundRequestData,
  ): Promise<P24RefundResponseData> {
    return this.makeRequest("/transaction/refund", "POST", refundData);
  }

  /**
   * Charge payment using BLIK code
   */
  async chargeBlikByCode(
    data: P24BlikChargeByCodeData,
  ): Promise<P24TransactionResponse> {
    return this.makeRequest("/paymentMethod/blik/chargeByCode", "POST", {
      token: data.token,
      blikCode: data.blikCode,
    });
  }

  /**
   * Charge card with 3DS (white-label iframe flow)
   */
  async chargeCardWith3ds(token: string): Promise<P24CardChargeResponse> {
    return this.makeRequest("/card/chargeWith3ds", "POST", { token });
  }

  /**
   * Charge card without 3DS redirect
   */
  async chargeCard(token: string): Promise<P24CardChargeResponse> {
    return this.makeRequest("/card/charge", "POST", { token });
  }

  /**
   * Get card metadata for an order
   */
  async getCardInfo(orderId: number): Promise<P24CardInfoResponse> {
    return this.makeRequest(`/card/info/${orderId}`, "GET");
  }

  /**
   * Make a generic request to P24 API
   */
  private async makeRequest(
    endpoint: string,
    method: string,
    data?: unknown,
  ): Promise<any> {
    const url = `${this.baseURL}${endpoint}`;

    const credentials = Buffer.from(
      `${this.options.pos_id}:${this.options.api_key}`,
    ).toString("base64");

    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${credentials}`,
      },
      body: data ? JSON.stringify(data) : undefined,
    });

    const responseText = await response.text();

    if (!response.ok) {
      throw new P24ApiError({
        status: response.status,
        statusText: response.statusText,
        method,
        endpoint,
        responseText,
        secrets: [
          this.options.api_key,
          this.options.crc,
          credentials,
          ...collectRequestSecrets(data),
        ],
      });
    }

    let parsed: unknown = {};

    if (responseText) {
      try {
        parsed = JSON.parse(responseText);
      } catch {
        parsed = { message: responseText };
      }
    }

    return parsed;
  }

  /**
   * Generate signature for transaction registration
   */
  generateSign(data: P24SignatureData): string {
    const jsonString = JSON.stringify(data, null, 0).replace(/\\\//g, "/");
    return crypto.createHash("sha384").update(jsonString, "utf8").digest("hex");
  }

  /**
   * Generate signature for transaction verification
   */
  generateVerificationSign(data: P24SignatureVerificationData): string {
    const jsonString = JSON.stringify(data, null, 0).replace(/\\\//g, "/");
    return crypto.createHash("sha384").update(jsonString, "utf8").digest("hex");
  }

  private secureCompareHex(expected: string, received: string): boolean {
    const expectedBuf = Buffer.from(expected, "hex");
    const receivedBuf = Buffer.from(received, "hex");

    if (expectedBuf.length !== receivedBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuf, receivedBuf);
  }

  /**
   * Verify webhook signature
   */
  verifyWebhookSignature(
    payload: P24WebhookPayload,
    receivedSign: string,
  ): boolean {
    const signData = {
      merchantId: parseInt(this.options.merchant_id),
      posId: parseInt(this.options.pos_id),
      sessionId: payload.sessionId,
      amount: payload.amount,
      originAmount: payload.originAmount,
      currency: payload.currency,
      orderId: payload.orderId,
      methodId: payload.methodId,
      statement: payload.statement,
      crc: this.options.crc,
    };

    const expectedSign = this.hashSignaturePayload(signData);
    return this.secureCompareHex(expectedSign, receivedSign);
  }

  verifyCardPaymentNotificationSignature(
    payload: P24CardPaymentNotificationPayload,
    receivedSign: string,
    isFailure = false,
  ): boolean {
    const signData = isFailure
      ? {
          merchantId: parseInt(this.options.merchant_id),
          posId: parseInt(this.options.pos_id),
          sessionId: payload.sessionId,
          orderId: payload.orderId,
          amount: payload.amount,
          currency: payload.currency,
          status: payload.status,
          crc: this.options.crc,
        }
      : {
          merchantId: parseInt(this.options.merchant_id),
          posId: parseInt(this.options.pos_id),
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
          crc: this.options.crc,
        };

    const expectedSign = this.hashSignaturePayload(signData);
    return this.secureCompareHex(expectedSign, receivedSign);
  }

  isAllowedWebhookIp(ipAddress: string | undefined): boolean {
    return isAllowedP24WebhookSourceIp(ipAddress, {
      sandbox: this.options.sandbox,
    });
  }

  private hashSignaturePayload(payload: Record<string, unknown>): string {
    const jsonString = JSON.stringify(payload, null, 0).replace(/\\\//g, "/");
    return crypto.createHash("sha384").update(jsonString, "utf8").digest("hex");
  }

  /**
   * Get base redirect URL for P24
   */
  getBaseRedirectURL(): string {
    return this.options.sandbox
      ? "https://sandbox.przelewy24.pl/trnRequest"
      : "https://secure.przelewy24.pl/trnRequest";
  }

  generateCardTokenizationSign(sessionId: string): string {
    return this.hashSignaturePayload({
      merchantId: parseInt(this.options.merchant_id),
      sessionId,
      crc: this.options.crc,
    });
  }

  getCardTokenizationScriptUrl(): string {
    const base = this.options.sandbox
      ? "https://sandbox.przelewy24.pl"
      : "https://secure.przelewy24.pl";

    return `${base}/js/cardTokenizationIframe.min.js`;
  }

  getCardWhitelabelScriptUrl(token: string): string {
    const base = this.options.sandbox
      ? "https://sandbox.przelewy24.pl"
      : "https://secure.przelewy24.pl";

    return `${base}/whitelabel/card/javascript/${encodeURIComponent(token)}`;
  }

  getCardWidgetScriptUrl(token: string): string {
    const base = this.options.sandbox
      ? "https://sandbox.przelewy24.pl"
      : "https://secure.przelewy24.pl";

    return `${base}/inchtml/ajaxPayment/ajax.js?token=${encodeURIComponent(token)}`;
  }
}

function collectRequestSecrets(data: unknown): string[] {
  if (!data || typeof data !== "object") {
    return [];
  }

  const record = data as Record<string, unknown>;
  return ["token", "sign", "blikCode"]
    .map((key) => record[key])
    .filter((value): value is string => typeof value === "string");
}
