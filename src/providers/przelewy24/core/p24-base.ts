import crypto from "crypto";
import {
  PaymentSessionStatus,
  WebhookActionResult,
  ProviderWebhookPayload,
  Logger,
} from "@medusajs/types";
import {
  AbstractPaymentProvider,
  ContainerRegistrationKeys,
  isDefined,
} from "@medusajs/framework/utils";
import {
  P24Options,
  P24PaymentIntentOptions,
  P24Transaction,
  P24TransactionBySessionIdResponse,
} from "../types";

import { P24ApiService } from "../services/p24-api";
import {
  fetchTransactionDetailsAndStatus,
  mapP24StatusToMedusaStatus,
} from "./p24-transaction-status";
import { processP24Webhook } from "./p24-webhook";
import {
  getSmallestUnit,
  getAmountFromSmallestUnit,
} from "../../../utils/get-smallest-unit";
import { coerceSandbox } from "../../../utils/coerce-sandbox";
import {
  getOrderId,
  getSessionId,
  inferMedusaPaymentSessionIdFromP24SessionId,
  normalizeP24SessionData,
  P24_CHARGE_SUBMITTED_AT_KEY,
} from "../../../utils/p24-session-data";
import {
  extractMethodIdFromSessionData,
  resolveP24PaymentMethodMetadata,
} from "../../../utils/p24-payment-methods";
import { createP24Logger, redactUnknown } from "../../../utils/p24-logger";
import { buildLocalizedP24ErrorMessage } from "../../../utils/p24-errors";
import { getJobErrorMessage } from "../../../utils/payment-job-errors";

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

type P24Container = Record<string, unknown> & {
  logger?: Logger;
};

type PaymentSessionQuery = {
  graph: (config: {
    entity: string;
    fields: string[];
    filters?: Record<string, unknown>;
  }) => Promise<{ data: Array<{ id: string; data?: Record<string, unknown> }> }>;
};

abstract class P24Base extends AbstractPaymentProvider<P24Options> {
  protected readonly options_: P24Options;
  protected readonly p24Api: P24ApiService;
  protected readonly container_: P24Container;
  protected readonly logger_: ReturnType<typeof createP24Logger>;

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
        "Required option `frontend_url` is missing in P24 plugin",
      );
    }
    if (!isDefined(options.backend_url)) {
      throw new Error("Required option `backend_url` is missing in P24 plugin");
    }
  }

  protected constructor(cradle: P24Container, options: P24Options) {
    super(cradle, {
      ...options,
      sandbox: coerceSandbox(options.sandbox),
    });

    this.container_ = cradle;
    this.options_ = {
      ...options,
      sandbox: coerceSandbox(options.sandbox),
      debug: Boolean(options.debug),
    };
    this.p24Api = new P24ApiService(this.options_);
    this.logger_ = createP24Logger(
      cradle.logger as Logger | undefined,
      Boolean(this.options_.debug),
    );
  }

  abstract get paymentIntentOptions(): P24PaymentIntentOptions;

  get options(): P24Options {
    return this.options_;
  }

  normalizePaymentCreateParams(): Partial<P24Transaction> {
    const options = this.paymentIntentOptions;
    const params: Partial<P24Transaction> = {
      description: options.description ?? "Payment via Przelewy24",
    };

    if (options.channel != null && options.channel > 0) {
      params.channel = options.channel;
    }

    if (options.method_id != null) {
      params.method = options.method_id;
    }

    return params;
  }

  protected buildTransactionRequest(
    input: InitiatePaymentInput,
    sessionId: string,
  ): P24Transaction {
    const { currency_code, amount, data, context } = input;
    const normalizedParams = this.normalizePaymentCreateParams();

    const customerEmail =
      context?.customer?.email ||
      (typeof data?.email === "string" && data.email.trim().length > 0
        ? data.email.trim()
        : undefined) ||
      ((data?.customer as Record<string, unknown>)?.email as string) ||
      "customer@example.com";

    const country = (data?.country as string)?.toUpperCase() || "PL";
    const language = (data?.language as string)?.toLowerCase() || "pl";

    const urlReturn =
      typeof data?.return_url === "string" && data.return_url.trim().length
        ? data.return_url
        : `${this.options_.frontend_url}/payment/return?cart_id=${data?.cart_id ?? ""}`;

    const psu = data?.psu as
      | {
          IP?: string;
          userAgent?: string;
        }
      | undefined;

    const regulationAccept =
      data?.regulation_accept === true || data?.regulationAccept === true;

    const cardRefId =
      typeof data?.card_ref_id === "string" ? data.card_ref_id : undefined;

    const cardPaymentNotificationUrl = this.getCardPaymentNotificationUrl();

    const transactionRequest: P24Transaction = {
      sessionId,
      amount: getSmallestUnit(Number(amount), currency_code),
      country,
      language,
      currency: currency_code.toUpperCase(),
      description:
        normalizedParams.description || `Payment ${context?.idempotency_key}`,
      email: customerEmail,
      channel: normalizedParams.channel,
      method: normalizedParams.method,
      urlReturn,
      urlStatus: `${this.options_.backend_url}/hooks/payment/${this.getProviderKey()}_przelewy24`,
      ...(cardPaymentNotificationUrl
        ? { urlCardPaymentNotification: cardPaymentNotificationUrl }
        : {}),
      ...(regulationAccept ? { regulationAccept: true } : {}),
    };

    if (cardRefId) {
      transactionRequest.cardData = {
        means: {
          referenceNumber: { id: cardRefId },
        },
        transactionType: "standard",
      };
    }

    if (psu?.IP && psu?.userAgent) {
      transactionRequest.additional = {
        PSU: {
          IP: psu.IP,
          userAgent: psu.userAgent,
        },
      };
    }

    return transactionRequest;
  }

  /** `urlCardPaymentNotification` sent on register; providers opt in. */
  protected getCardPaymentNotificationUrl(): string | undefined {
    return undefined;
  }

  protected resolvePaymentSessionQuery(): PaymentSessionQuery | undefined {
    const resolve = this.container_.resolve;

    if (typeof resolve !== "function") {
      return undefined;
    }

    try {
      const query = resolve.call(
        this.container_,
        ContainerRegistrationKeys.QUERY,
      ) as PaymentSessionQuery | undefined;

      if (query && typeof query.graph === "function") {
        return query;
      }
    } catch {
      // Payment provider scope does not register QUERY (e.g. webhook handling).
    }

    return undefined;
  }

  protected async findMedusaPaymentSessionId(
    p24SessionId: string,
  ): Promise<string> {
    const inferred =
      inferMedusaPaymentSessionIdFromP24SessionId(p24SessionId);

    if (inferred) {
      return inferred;
    }

    const query = this.resolvePaymentSessionQuery();

    if (!query) {
      return p24SessionId;
    }

    const byId = await query.graph({
      entity: "payment_session",
      fields: ["id", "data"],
      filters: { id: p24SessionId },
    });

    if (byId.data?.[0]?.id) {
      return byId.data[0].id;
    }

    const providerPrefix = `pp_${this.getProviderKey()}`;
    const sessions = await query.graph({
      entity: "payment_session",
      fields: ["id", "data"],
      filters: {
        provider_id: { $like: `${providerPrefix}%` },
      },
    });

    const matched = sessions.data?.find((session) => {
      const sessionData = session.data ?? {};
      return (
        sessionData.session_id === p24SessionId ||
        sessionData.sessionId === p24SessionId
      );
    });

    return matched?.id ?? p24SessionId;
  }

  protected async enrichPaymentMethodFields(
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const methodId = extractMethodIdFromSessionData(data);

    if (!methodId) {
      return data;
    }

    if (
      data.paymentMethod === methodId &&
      typeof data.paymentMethodName === "string" &&
      data.paymentMethodName.length > 0 &&
      typeof data.paymentMethodGroup === "string" &&
      data.paymentMethodGroup.length > 0
    ) {
      return data;
    }

    const currency = String(data.currency_code ?? data.currency ?? "PLN");
    const lang = String(data.language ?? "pl").toLowerCase();
    const amountGrosze =
      typeof data.amount_grosze === "number" && Number.isFinite(data.amount_grosze)
        ? Math.trunc(data.amount_grosze)
        : typeof data.amount === "number" && Number.isFinite(data.amount)
          ? getSmallestUnit(data.amount, currency)
          : 0;

    const metadata = await resolveP24PaymentMethodMetadata(this.p24Api, {
      methodId,
      lang,
      amountGrosze,
      currency,
      providerKey: this.getProviderKey(),
    });

    return {
      ...data,
      ...metadata,
      method_id: methodId,
      methodId,
    };
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const { currency_code, amount, context, data } = input;

    try {
      const sessionId = context?.idempotency_key as string;
      const p24SessionId = (data?.p24_session_id as string) || sessionId;

      if (!sessionId) {
        throw this.buildError(
          "Missing idempotency key for P24 transaction",
          new Error("idempotency_key is required"),
        );
      }

      this.logger_.debug(
        `Initiating P24 payment amount=${amount} ${currency_code} session=${sessionId} context=${JSON.stringify(redactUnknown(context))}`,
      );

      const transactionRequest = this.buildTransactionRequest(input, p24SessionId);

      const sessionData =
        await this.p24Api.registerTransaction(transactionRequest);

      if (sessionData.responseCode !== 0) {
        throw this.buildError(
          buildLocalizedP24ErrorMessage(
            sessionData,
            "Failed to register P24 transaction",
          ),
          new Error(
            `P24 API error: ${sessionData.responseCode} - ${
              sessionData.message || "Unknown error"
            }`,
          ),
        );
      }

      const isWhiteLabel = Boolean(this.paymentIntentOptions.white_label);
      const redirectUrl = `${this.p24Api.getBaseRedirectURL()}/${sessionData.data.token}`;

      const normalizedData = await this.enrichPaymentMethodFields(
        normalizeP24SessionData({
          session_id: transactionRequest.sessionId,
          medusa_payment_session_id: sessionId,
          token: sessionData.data.token,
          amount: Number(amount),
          amount_grosze: transactionRequest.amount,
          currency: currency_code,
          currency_code,
          description: transactionRequest.description,
          email: transactionRequest.email,
          country: transactionRequest.country,
          language: transactionRequest.language,
          channel: transactionRequest.channel,
          method_id: transactionRequest.method,
          ...(transactionRequest.method != null
            ? { paymentMethod: transactionRequest.method }
            : {}),
          white_label: isWhiteLabel,
          ...(isWhiteLabel ? {} : { redirect_url: redirectUrl }),
          responseCode: sessionData.responseCode,
        }),
      );

      this.logger_.info(`P24 payment initiated for session ${sessionId}`);

      return {
        id: transactionRequest.sessionId,
        data: normalizedData,
      };
    } catch (error) {
      this.logger_.error(
        `Error initiating P24 payment: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  async authorizePayment(
    input: AuthorizePaymentInput,
  ): Promise<AuthorizePaymentOutput> {
    const sessionId = getSessionId(input.data);

    if (!sessionId) {
      throw this.buildError(
        "Session ID is required for payment authorization",
        new Error("No session ID provided"),
      );
    }

    try {
      const { transactionDetails, p24Status, medusaStatus } =
        await this.getTransactionDetailsAndStatus(sessionId);

      if (!["authorized", "captured"].includes(medusaStatus)) {
        throw this.buildError(
          `Payment is not in a valid state for authorization: current status is ${medusaStatus}`,
          new Error(`Invalid payment status: ${medusaStatus}`),
        );
      }

      // Medusa records the payment at the session amount, whatever P24 took
      const registeredGrosze = input.data?.amount_grosze;
      const paidGrosze = Number(transactionDetails.data.amount);

      if (typeof registeredGrosze === "number" && paidGrosze !== registeredGrosze) {
        throw this.buildError(
          "Payment amount does not match the registered amount",
          new Error(
            `amount_mismatch: registered ${registeredGrosze}, paid ${paidGrosze}`,
          ),
        );
      }

      let data = await this.enrichPaymentMethodFields(
        normalizeP24SessionData({
          ...input.data,
          ...transactionDetails.data,
          amount_grosze: transactionDetails.data.amount,
          p24_status: p24Status,
          order_id: transactionDetails.data.orderId,
        }),
      );

      const currencyCode =
        (data.currency as string) || (input.data?.currency_code as string);

      if (!currencyCode) {
        throw this.buildError(
          `Missing currency code for amount conversion in authorizePayment (session: ${sessionId})`,
          new Error("currency_code is required to convert P24 amount"),
        );
      }

      if (data.amount != null) {
        data.amount = getAmountFromSmallestUnit(
          data.amount as number,
          currencyCode,
        );
      }

      if (data.originAmount != null) {
        data.originAmount = getAmountFromSmallestUnit(
          data.originAmount as number,
          currencyCode,
        );
      }

      return {
        data,
        status: medusaStatus,
      };
    } catch (error) {
      this.logger_.error(
        `Error authorizing payment ${sessionId}: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  async capturePayment(
    input: CapturePaymentInput,
  ): Promise<CapturePaymentOutput> {
    const sessionId = getSessionId(input.data);
    const amount = input.data?.amount as number;
    const currency = (input.data?.currency as string) || (input.data?.currency_code as string);
    const orderId = getOrderId(input.data);

    if (!sessionId || amount == null || !currency || orderId == null) {
      throw this.buildError(
        "Missing required data for payment capture",
        new Error("Session ID, amount, currency, and order ID are required"),
      );
    }

    try {
      const verification = await this.p24Api.verifyTransaction(
        sessionId,
        getSmallestUnit(amount, currency),
        currency,
        orderId,
      );

      if (
        verification.responseCode !== 0 ||
        verification.data.status !== "success"
      ) {
        throw this.buildError(
          "Payment capture failed",
          new Error(
            `Verification failed - responseCode: ${verification.responseCode}, status: ${verification.data.status}`,
          ),
        );
      }

      return {
        data: await this.enrichPaymentMethodFields(
          normalizeP24SessionData({
            ...input.data,
            status: "captured",
            captured_at: new Date().toISOString(),
            order_id: orderId,
            capture_verified: true,
          }),
        ),
      };
    } catch (error) {
      // Capture is the only place a transaction gets verified, so a failure
      // here leaves a paid transaction unsettled.
      this.logger_.error(
        `Error capturing payment ${sessionId}: ${getJobErrorMessage(error)}`,
      );

      throw error;
    }
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    return {
      data: input.data,
    };
  }

  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    return {
      data: input.data,
    };
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    const { data: paymentData, amount: refundAmount, context } = input;
    const sessionId = getSessionId(paymentData);
    const orderId = getOrderId(paymentData);

    if (!sessionId || orderId == null) {
      throw this.buildError(
        "No session ID or order ID provided while refunding payment",
        new Error("Missing session ID or order ID"),
      );
    }

    try {
      const refundsUuid = crypto.randomUUID();
      const requestId = context?.idempotency_key;

      if (typeof requestId !== "string" || requestId.length === 0) {
        throw this.buildError(
          "Missing idempotency key for refund request",
          new Error("context.idempotency_key is required"),
        );
      }

      const currencyCode =
        (paymentData?.currency_code as string) ||
        (paymentData?.currency as string) ||
        "pln";

      const refundData = {
        requestId,
        refunds: [
          {
            orderId,
            sessionId,
            amount: getSmallestUnit(Number(refundAmount), currencyCode),
            description: `Refund for order ${sessionId}`,
          },
        ],
        refundsUuid,
      };

      const refundResult = await this.p24Api.processRefund(refundData);
      const refundStatus = refundResult.data[0]?.status;
      const refundMessage = refundResult.data[0]?.message;

      if (refundResult.responseCode !== 0 || !refundStatus) {
        throw this.buildError(
          "Refund request failed",
          new Error(
            `P24 API error: ${refundResult.responseCode} - ${
              refundMessage || "Unknown error"
            }`,
          ),
        );
      }

      const p24RefundsNormal = Array.isArray(refundResult.data)
        ? refundResult.data.map((item: Record<string, unknown>) => {
            const out = { ...item };
            const curr = (item.currency as string) || currencyCode;
            if (out.amount != null) {
              out.amount = getAmountFromSmallestUnit(
                out.amount as number,
                curr,
              );
            }
            if (out.originAmount != null) {
              out.originAmount = getAmountFromSmallestUnit(
                out.originAmount as number,
                curr,
              );
            }
            return out;
          })
        : refundResult.data;

      return {
        data: normalizeP24SessionData({
          ...paymentData,
          refund_amount: refundAmount,
          refunded_at: new Date().toISOString(),
          refunds_uuid: refundsUuid,
          refund_request_id: requestId,
          refund_status: refundStatus,
          refund_message: refundMessage,
          p24_refunds: p24RefundsNormal,
          p24_response_code: refundResult.responseCode,
          status: "refund_requested",
        }),
      };
    } catch (e) {
      throw this.buildError("An error occurred in refundPayment", e);
    }
  }

  async retrievePayment(
    input: RetrievePaymentInput,
  ): Promise<RetrievePaymentOutput> {
    try {
      return {
        data: normalizeP24SessionData(input.data),
      };
    } catch (e) {
      throw this.buildError("An error occurred in retrievePayment", e);
    }
  }

  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    const { data, amount, currency_code, context } = input;
    const amountNumeric = Number(amount);
    const currentAmount = Number(data?.amount);

    if (Number.isFinite(currentAmount) && currentAmount === amountNumeric) {
      return { data: normalizeP24SessionData(data) };
    }

    const baseSessionId =
      (context?.idempotency_key as string | undefined) || getSessionId(data);

    if (!baseSessionId) {
      throw this.buildError(
        "Cannot update P24 payment without session id",
        new Error("Missing session id"),
      );
    }

    const newP24SessionId = `${baseSessionId}-${crypto.randomUUID()}`;
    const {
      [P24_CHARGE_SUBMITTED_AT_KEY]: _previousRegistrationCharge,
      ...carriedData
    } = data ?? {};

    const initiated = await this.initiatePayment({
      amount,
      currency_code,
      context: {
        ...context,
        idempotency_key: baseSessionId,
      },
      data: {
        ...carriedData,
        amount: amountNumeric,
        medusa_payment_session_id: baseSessionId,
        p24_session_id: newP24SessionId,
      },
    });

    return {
      data: normalizeP24SessionData({
        ...carriedData,
        ...initiated.data,
        session_id: initiated.data?.session_id,
        medusa_payment_session_id: baseSessionId,
        amount: amountNumeric,
      }),
    };
  }

  async getWebhookActionAndData(
    webhookData: ProviderWebhookPayload["payload"],
  ): Promise<WebhookActionResult> {
    return processP24Webhook(
      {
        p24Api: this.p24Api,
        logger: this.logger_,
        findMedusaPaymentSessionId: (p24SessionId) =>
          this.findMedusaPaymentSessionId(p24SessionId),
        buildError: (message, error) => this.buildError(message, error),
      },
      webhookData,
    );
  }

  async getPaymentStatus(
    input: GetPaymentStatusInput,
  ): Promise<GetPaymentStatusOutput> {
    const sessionId = input.context?.idempotency_key;

    if (!sessionId) {
      this.logger_.warn(
        "No session ID provided for getPaymentStatus, returning pending",
      );
      return { status: "pending" as PaymentSessionStatus };
    }

    try {
      const { medusaStatus } =
        await this.getTransactionDetailsAndStatus(sessionId);
      return { status: medusaStatus };
    } catch (error) {
      this.logger_.error(
        `Error getting payment status for session ${sessionId}: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  async queryTransactionStatus(sessionId: string) {
    return this.getTransactionDetailsAndStatus(sessionId);
  }

  protected async getTransactionDetailsAndStatus(sessionId: string): Promise<{
    transactionDetails: P24TransactionBySessionIdResponse;
    p24Status: number;
    medusaStatus: PaymentSessionStatus;
  }> {
    return fetchTransactionDetailsAndStatus(
      {
        p24Api: this.p24Api,
        logger: this.logger_,
        buildError: (message, error) => this.buildError(message, error),
      },
      sessionId,
    );
  }

  protected abstract getProviderKey(): string;

  protected mapP24StatusToMedusaStatus(
    p24Status: number,
  ): PaymentSessionStatus {
    return mapP24StatusToMedusaStatus(p24Status);
  }

  protected buildError(message: string, error?: unknown): Error {
    const suffix =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Unknown error";

    return new Error(`${message}: ${suffix}`.trim());
  }
}

export default P24Base;
