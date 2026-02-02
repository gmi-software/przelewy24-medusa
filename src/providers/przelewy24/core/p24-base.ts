import crypto from "crypto";
import {
  PaymentSessionStatus,
  WebhookActionResult,
  ProviderWebhookPayload,
} from "@medusajs/types";
import {
  AbstractPaymentProvider,
  isDefined,
  PaymentActions,
} from "@medusajs/framework/utils";
import {
  P24Options,
  P24PaymentIntentOptions,
  P24Transaction,
  P24WebhookPayload,
  P24TransactionBySessionIdResponse,
} from "../types";

import { P24ApiService } from "../services/p24-api";

import {
  InitiatePaymentInput,
  InitiatePaymentOutput,
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
} from "@medusajs/framework/types";

abstract class P24Base extends AbstractPaymentProvider<P24Options> {
  protected readonly options_: P24Options;
  protected readonly p24Api: P24ApiService;
  protected container_: Record<string, unknown>;

  static validateOptions(options: P24Options): void {
    if (!isDefined(options.merchant_id)) {
      throw new Error("Required option `merchant_id` is missing in P24 plugin");
    }
    if (!isDefined(options.pos_id)) {
      throw new Error("Required option `pos_id` is missing in P24 plugin");
    }
    if (!isDefined(options.api_key)) {
      throw new Error("Required option `api_key` is missing in P24 plugin");
    }
    if (!isDefined(options.crc)) {
      throw new Error("Required option `crc` is missing in P24 plugin");
    }
    if (!isDefined(options.frontend_url)) {
      throw new Error(
        "Required option `frontend_url` is missing in P24 plugin"
      );
    }
    if (!isDefined(options.backend_url)) {
      throw new Error("Required option `backend_url` is missing in P24 plugin");
    }
  }

  protected constructor(cradle: Record<string, unknown>, options: P24Options) {
    // @ts-ignore
    super(...arguments);

    this.container_ = cradle;
    this.options_ = options;
    this.p24Api = new P24ApiService(options);
  }

  abstract get paymentIntentOptions(): P24PaymentIntentOptions;

  get options(): P24Options {
    return this.options_;
  }

  /**
   * Normalizes payment create parameters for P24 transaction registration.
   *
   * This method prepares the common parameters that will be used across all
   * P24 payment methods (cards, BLIK, etc.) based on the provider-specific options.
   *
   * @returns Normalized P24 transaction parameters
   */
  normalizePaymentCreateParams(): Partial<P24Transaction> {
    const res = {} as Partial<P24Transaction>;

    res.description =
      this.paymentIntentOptions.description ?? "Payment via Przelewy24";
    res.channel = this.paymentIntentOptions.channel;

    return res;
  }

  /**
   * Initiates a new payment with Przelewy24.
   *
   * This method creates a payment session with P24 by registering a transaction.
   * It uses provider-specific options (channel, method) from the concrete implementations
   * and normalizes common parameters for all P24 payment methods.
   *
   * @param input - The payment initiation input containing amount, currency, and context
   * @returns The initiated payment details with session ID and redirect URL
   */
  async initiatePayment({
    currency_code,
    amount,
    data,
    context,
  }: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    try {
      console.log(
        `Initiating P24 payment - Amount: ${amount} ${currency_code}`
      );
      console.log(`Context:`, context);
      console.log("data: ", data);

      const normalizedParams = this.normalizePaymentCreateParams();

      const customerEmail =
        context?.customer?.email ||
        ((data?.customer as Record<string, unknown>)?.email as string) ||
        "customer@example.com";

      const country = (data?.country as string)?.toUpperCase() || "PL";
      const language = (data?.language as string)?.toLowerCase() || "pl";

      console.log(`Using country: ${country}, language: ${language}`);

      // Prefer data.return_url (non-empty string); otherwise fallback to default
      const urlReturn =
        typeof data?.return_url === "string" && data.return_url.trim().length
          ? data.return_url
          : `${this.options_.frontend_url}/payment/return?cart_id=${data?.cart_id ?? ""}`;

      const transactionRequest: P24Transaction = {
        sessionId: context?.idempotency_key as string,
        amount: Number(amount),
        country: country,
        language: language,
        currency: currency_code.toUpperCase(),
        description:
          normalizedParams.description || `Payment ${context?.idempotency_key}`,
        email: customerEmail,
        channel: normalizedParams.channel,
        urlReturn,
        urlStatus: `${
          this.options_.backend_url
        }/hooks/payment/${this.getProviderKey()}_przelewy24`,
      };

      console.log(
        `Registering P24 transaction with session ID: ${transactionRequest.sessionId}`
      );

      const sessionData = await this.p24Api.registerTransaction(
        transactionRequest
      );

      console.log(`P24 transaction response:`, sessionData);

      if (sessionData.responseCode !== 0) {
        throw this.buildError(
          "Failed to register P24 transaction",
          new Error(
            `P24 API error: ${sessionData.responseCode} - ${
              sessionData.message || "Unknown error"
            }`
          )
        );
      }

      console.log(
        `P24 payment ${transactionRequest.sessionId} successfully initiated`
      );

      return {
        id: transactionRequest.sessionId,
        data: {
          session_id: transactionRequest.sessionId,
          token: sessionData.data.token,
          redirect_url: `${this.p24Api.getBaseRedirectURL()}/${
            sessionData.data.token
          }`,
          amount: amount,
          currency: currency_code,
          description: transactionRequest.description,
          email: transactionRequest.email,
          country: country,
          language: language,
          channel: transactionRequest.channel,
          ...sessionData,
        } as Record<string, unknown>,
      };
    } catch (error) {
      console.error(`Error initiating P24 payment: ${error.message}`);
      throw error;
    }
  }

  /**
   * Authorizes a payment session using the third-party payment provider.
   *
   * During checkout, the customer may need to perform actions required by the payment provider,
   * such as entering their card details or confirming the payment. Once that is done, the
   * customer can place their order.
   *
   * During cart-completion before placing the order, this method is used to authorize the
   * cart's payment session with the third-party payment provider. The payment can later be
   * captured using the capturePayment method.
   *
   * For P24, this method validates the payment status by fetching transaction details
   * from P24 and mapping P24 statuses (0-3) to Medusa payment statuses:
   * - 0: pending
   * - 1: authorized
   * - 2: captured
   * - 3: canceled
   *
   * @param input - The authorize payment input containing the payment data
   * @returns The payment data with authorization status
   */
  async authorizePayment(
    input: AuthorizePaymentInput
  ): Promise<AuthorizePaymentOutput> {
    console.log("----- REACHED TO THE AUTHORIZE PAYMENT -----");
    console.log("input from authorize: ", input);

    const sessionId = input.data?.session_id as string;

    if (!sessionId) {
      throw this.buildError(
        "Session ID is required for payment authorization",
        new Error("No session ID provided")
      );
    }

    try {
      const { transactionDetails, p24Status, medusaStatus } =
        await this.getTransactionDetailsAndStatus(sessionId);

      console.log(
        "transactionDetails (in authorize payment): ",
        transactionDetails
      );

      if (!["authorized", "captured", "pending"].includes(medusaStatus)) {
        throw this.buildError(
          `Payment is not in a valid state for authorization: current status is ${medusaStatus}`,
          new Error(`Invalid payment status: ${medusaStatus}`)
        );
      }

      return {
        data: {
          ...input.data,
          ...transactionDetails.data,
          p24_status: p24Status,
        },
        status: medusaStatus,
      };
    } catch (error) {
      console.error(`Error authorizing payment ${sessionId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Captures a payment using the third-party provider.
   *
   * This method provides manual payment capture capability for admin users.
   * In normal operation, payments are automatically verified and captured via webhook
   * processing in getWebhookActionAndData. This method serves as a backup option.
   *
   * According to P24 documentation, transaction/verify is required to confirm the payment
   * and transfer the amount to the merchant. Without verification, the amount stays as
   * an advance payment at the customer's disposal.
   *
   * @param input - The capture payment input containing the payment data
   * @returns The payment data with capture confirmation
   */
  async capturePayment(
    input: CapturePaymentInput
  ): Promise<CapturePaymentOutput> {
    console.log("----- REACHED TO THE CAPTURE PAYMENT -----");
    console.log("input from capture: ", input);

    const sessionId = input.data?.sessionId as string;
    const amount = input.data?.amount as number;
    const currency = input.data?.currency as string;
    const orderId = input.data?.orderId as number;

    if (!sessionId || !amount || !currency || !orderId) {
      throw this.buildError(
        "Missing required data for payment capture",
        new Error("Session ID, amount, currency, and order ID are required")
      );
    }

    try {
      console.log(`Capturing payment ${sessionId} with order ID ${orderId}...`);

      // Call transaction/verify to confirm and capture the payment
      const verification = await this.p24Api.verifyTransaction(
        sessionId,
        amount,
        currency,
        orderId
      );

      if (
        verification.responseCode !== 0 ||
        verification.data.status !== "success"
      ) {
        throw this.buildError(
          "Payment capture failed",
          new Error(
            `Verification failed - responseCode: ${verification.responseCode}, status: ${verification.data.status}`
          )
        );
      }

      console.log(`Payment ${sessionId} successfully captured`);

      return {
        data: {
          ...input.data,
          status: "captured",
          captured_at: new Date().toISOString(),
          order_id: orderId,
          capture_verified: true,
        },
      };
    } catch (error) {
      console.error(`Error capturing payment ${sessionId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Deletes a payment session in the third-party payment provider.
   *
   * P24 doesn't support programmatic deletion of payment sessions.
   * Payment sessions expire automatically after 15 minutes.
   *
   * When a customer chooses a payment method during checkout, then chooses a different one,
   * this method is triggered to delete the previous payment session.
   *
   * @param input - The delete payment input containing the payment data
   * @returns The same payment data (no deletion performed)
   */
  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    return {
      data: input.data,
    };
  }

  /**
   * Cancels a payment in the third-party payment provider.
   *
   * P24 doesn't support programmatic cancellation of payments.
   * Payments can only be canceled through the P24 merchant panel.
   *
   * This method is used when the admin user cancels an order.
   * The order can only be canceled if the payment is not captured yet.
   *
   * @param input - The cancel payment input containing the payment data
   * @returns The same payment data (no cancellation performed)
   */
  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    return {
      data: input.data,
    };
  }

  /**
   * Refunds an amount using the P24 payment provider.
   *
   * This method is triggered when the admin user refunds a payment of an order.
   * It creates a refund request to P24 using the transaction/refund endpoint.
   *
   * The method uses the session ID and order ID from the payment data to identify
   * the transaction to refund, and generates a unique UUID for tracking the refund.
   *
   * @param input - The input to refund the payment containing amount and payment data
   * @returns The payment data with refund information and status
   */
  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    const { data: paymentData, amount: refundAmount, context } = input;
    const sessionId = paymentData?.session_id as string;
    const orderId = paymentData?.order_id as number;

    if (!sessionId || !orderId) {
      throw this.buildError(
        "No session ID or order ID provided while refunding payment",
        new Error("Missing session ID or order ID")
      );
    }

    try {
      const currencyCode = (paymentData?.currency as string) || "PLN";

      const refundsUuid = crypto.randomUUID().substring(0, 35);

      const requestId = context?.idempotency_key || `refund-${Date.now()}`;

      const refundData = {
        requestId: requestId,
        refunds: [
          {
            orderId: orderId,
            sessionId: sessionId,
            amount: Number(refundAmount),
            description: `Refund for order ${sessionId}`,
          },
        ],
        refundsUuid: refundsUuid,
        // urlStatus: this.options_.backend_url
        //   ? `${
        //       this.options_.backend_url
        //     }/hooks/refund/${this.getProviderKey()}_przelewy24`
        //   : undefined,
      };

      const refundResult = await this.p24Api.processRefund(refundData);

      // Check if refund was successful
      const refundStatus = refundResult.data[0]?.status;
      const refundMessage = refundResult.data[0]?.message;

      if (refundResult.responseCode !== 0 || !refundStatus) {
        throw this.buildError(
          "Refund request failed",
          new Error(
            `P24 API error: ${refundResult.responseCode} - ${
              refundMessage || "Unknown error"
            }`
          )
        );
      }

      return {
        data: {
          ...paymentData,
          refund_amount: refundAmount,
          refunded_at: new Date().toISOString(),
          refunds_uuid: refundsUuid,
          refund_request_id: requestId,
          refund_status: refundStatus,
          refund_message: refundMessage,
          status: "refund_requested",
        },
      };
    } catch (e) {
      throw this.buildError("An error occurred in refundPayment", e);
    }
  }

  async retrievePayment(
    input: RetrievePaymentInput
  ): Promise<RetrievePaymentOutput> {
    try {
      const { data: paymentSessionData } = input;

      // Note: This would need the full transaction data to verify
      return {
        data: paymentSessionData,
      };
    } catch (e) {
      throw this.buildError("An error occurred in retrievePayment", e);
    }
  }

  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    const { data, amount } = input;
    const amountNumeric = Number(amount);

    if (data?.amount === amountNumeric) {
      return { data };
    }

    // P24 doesn't support updating payment amounts after creation
    // We need to create a new payment session
    throw this.buildError(
      "P24 doesn't support updating payment amounts. Please create a new payment session.",
      new Error("Update not supported")
    );
  }

  /**
   * Processes webhook data from P24
   *
   * @param webhookData - The webhook payload from P24
   * @returns The action and data to be processed
   */
  async getWebhookActionAndData(
    webhookData: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    const { data } = webhookData;

    try {
      const payload = data as unknown as P24WebhookPayload;
      const { sessionId, orderId, amount, currency, sign } = payload;

      console.log("----------- P24 WEBHOOK RECEIVED -----------");
      console.log("Session ID:", sessionId);
      console.log("Order ID:", orderId);
      console.log("Amount:", amount);
      console.log("Currency:", currency);

      if (!this.p24Api.verifyWebhookSignature(payload, sign)) {
        console.error(`Invalid webhook signature for session ${sessionId}`);
        return { action: PaymentActions.NOT_SUPPORTED };
      }

      console.log("Verifying transaction with P24...");
      const verification = await this.p24Api.verifyTransaction(
        sessionId,
        amount,
        currency,
        orderId
      );

      if (
        verification.responseCode !== 0 ||
        verification.data.status !== "success"
      ) {
        console.error(
          `Transaction verification failed - responseCode: ${verification.responseCode}, status: ${verification.data.status}`
        );
        return {
          action: PaymentActions.FAILED,
          data: {
            session_id: sessionId,
            amount: amount,
          },
        };
      }

      console.log("Transaction verified successfully");

      const { medusaStatus } = await this.getTransactionDetailsAndStatus(
        sessionId
      );

      const webhookData = {
        session_id: sessionId,
        amount: amount,
      };

      switch (medusaStatus) {
        case "authorized":
          return {
            action: PaymentActions.AUTHORIZED,
            data: webhookData,
          };
        case "captured":
          return {
            action: PaymentActions.SUCCESSFUL,
            data: webhookData,
          };
        case "pending":
          return {
            action: PaymentActions.PENDING,
            data: webhookData,
          };
        case "canceled":
          return {
            action: PaymentActions.CANCELED,
            data: webhookData,
          };
        case "error":
          return {
            action: PaymentActions.FAILED,
            data: webhookData,
          };
        default:
          return {
            action: PaymentActions.NOT_SUPPORTED,
            data: webhookData,
          };
      }
    } catch (error) {
      console.error("Error processing P24 webhook:", error);

      // Try to extract basic information even if there's an error
      try {
        const fallbackPayload =
          webhookData.data as unknown as P24WebhookPayload;
        const { sessionId, amount, currency } = fallbackPayload;

        if (sessionId && amount && currency) {
          return {
            action: PaymentActions.FAILED,
            data: {
              session_id: sessionId,
              amount: amount,
            },
          };
        }
      } catch (fallbackError) {
        console.error("Failed to extract fallback data:", fallbackError);
      }

      throw error;
    }
  }

  /**
   * Gets the payment status from P24 based on the session ID.
   * This method fetches the current status from P24 and maps it to Medusa's format.
   *
   * @param input - The get payment status input containing session data
   * @returns The current payment status from P24
   */
  async getPaymentStatus(
    input: GetPaymentStatusInput
  ): Promise<GetPaymentStatusOutput> {
    const sessionId = input.context?.idempotency_key;

    if (!sessionId) {
      console.warn(
        "No session ID provided for getPaymentStatus, returning pending"
      );
      return { status: "pending" as PaymentSessionStatus };
    }

    console.log(`Fetching payment status for session: ${sessionId}`);

    try {
      const { medusaStatus } = await this.getTransactionDetailsAndStatus(
        sessionId
      );
      return { status: medusaStatus };
    } catch (error) {
      console.error(
        `Error getting payment status for session ${sessionId}: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Gets transaction details and maps status from P24
   * This is a reusable method to avoid code duplication across payment methods
   *
   * @param sessionId - The P24 session ID
   * @returns Object containing transaction details and mapped Medusa status
   */
  protected async getTransactionDetailsAndStatus(sessionId: string): Promise<{
    transactionDetails: P24TransactionBySessionIdResponse;
    p24Status: number;
    medusaStatus: PaymentSessionStatus;
  }> {
    const transactionDetails = await this.p24Api.getTransactionBySessionId(
      sessionId
    );

    if (transactionDetails.responseCode !== 0) {
      throw this.buildError(
        "Failed to retrieve transaction details",
        new Error(`P24 API error: ${transactionDetails.responseCode}`)
      );
    }

    const p24Status = parseInt(transactionDetails.data.status);
    const medusaStatus = this.mapP24StatusToMedusaStatus(p24Status);

    console.log(`P24 Status: ${p24Status} -> Medusa Status: ${medusaStatus}`);

    return {
      transactionDetails,
      p24Status,
      medusaStatus,
    };
  }

  protected abstract getProviderKey(): string;

  /**
   * Maps P24 transaction status to Medusa payment status
   * P24 statuses: 0 - no payment, 1 - advance payment, 2 - payment made, 3 - payment returned
   * Medusa statuses: "authorized" | "captured" | "pending" | "requires_more" | "error" | "canceled"
   */
  protected mapP24StatusToMedusaStatus(
    p24Status: number
  ): PaymentSessionStatus {
    switch (p24Status) {
      case 0: // no payment
        return "pending";
      case 1: // advance payment
        return "authorized";
      case 2: // payment made
        return "captured";
      case 3: // payment returned
        return "canceled";
      default:
        return "error";
    }
  }

  protected buildError(message: string, error?: any): Error {
    return new Error(`${message}: ${error?.message || "Unknown error"}`.trim());
  }
}

export default P24Base;
