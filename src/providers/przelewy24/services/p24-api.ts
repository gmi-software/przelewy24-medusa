import crypto from "crypto";
import {
  P24Options,
  P24Transaction,
  P24TransactionResponse,
  P24VerificationResponse,
  P24TransactionBySessionIdResponse,
  P24SignatureData,
  P24SignatureVerificationData,
  P24WebhookPayload,
  P24RefundRequestData,
  P24RefundResponseData,
} from "../types";

export class P24ApiService {
  private readonly options: P24Options;
  private readonly baseURL: string;

  constructor(options: P24Options) {
    this.options = options;
    this.baseURL = options.sandbox
      ? "https://sandbox.przelewy24.pl/api/v1"
      : "https://secure.przelewy24.pl/api/v1";
  }

  /**
   * Register a new transaction with P24
   */
  async registerTransaction(
    data: P24Transaction
  ): Promise<P24TransactionResponse> {
    const requestData = {
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

    return this.makeRequest("/transaction/register", "POST", requestData);
  }

  /**
   * Verify a transaction with P24
   */
  async verifyTransaction(
    sessionId: string,
    amount: number,
    currency: string,
    orderId: number
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
   * Get transaction details by session ID
   */
  async getTransactionBySessionId(
    sessionId: string
  ): Promise<P24TransactionBySessionIdResponse> {
    const endpoint = `/transaction/by/sessionId/${sessionId}`;
    return this.makeRequest(endpoint, "GET");
  }

  /**
   * Process a refund
   */
  async processRefund(
    refundData: P24RefundRequestData
  ): Promise<P24RefundResponseData> {
    return this.makeRequest("/transaction/refund", "POST", refundData);
  }

  /**
   * Charge payment using BLIK code
   * This is the main BLIK payment method
   */
  async chargeBlikByCode(data: {
    token: string;
    blikCode: string;
  }): Promise<any> {
    const requestData = {
      token: data.token,
      blikCode: data.blikCode,
    };

    return this.makeRequest(
      "/paymentMethod/blik/chargeByCode",
      "POST",
      requestData
    );
  }

  /**
   * Make a generic request to P24 API
   */
  private async makeRequest(
    endpoint: string,
    method: string,
    data?: any
  ): Promise<any> {
    const url = `${this.baseURL}${endpoint}`;

    // P24 uses Basic authentication: pos_id as username, api_key as password
    const credentials = Buffer.from(
      `${this.options.pos_id}:${this.options.api_key}`
    ).toString("base64");

    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${credentials}`,
      },
      body: data ? JSON.stringify(data) : undefined,
    });

    if (!response.ok) {
      throw new Error(
        `P24 API request failed: ${response.status} ${response.statusText}`
      );
    }

    return response.json();
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

  /**
   * Verify webhook signature
   */
  verifyWebhookSignature(
    payload: P24WebhookPayload,
    receivedSign: string
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

    const jsonString = JSON.stringify(signData, null, 0).replace(/\\\//g, "/");
    const expectedSign = crypto
      .createHash("sha384")
      .update(jsonString, "utf8")
      .digest("hex");

    return expectedSign === receivedSign;
  }

  /**
   * Get base redirect URL for P24
   */
  getBaseRedirectURL(): string {
    return this.options.sandbox
      ? "https://sandbox.przelewy24.pl/trnRequest"
      : "https://secure.przelewy24.pl/trnRequest";
  }
}
