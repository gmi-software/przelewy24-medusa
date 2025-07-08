export interface P24Options {
  merchant_id: string;
  pos_id: string;
  api_key: string;
  crc: string;
  sandbox: boolean;
  frontend_url: string;
  backend_url: string;
}

export interface P24PaymentIntentOptions {
  channel: number;
  description?: string;
}

export interface P24Transaction {
  sessionId: string;
  amount: number;
  currency: string;
  description: string;
  email: string;
  country: string;
  language?: string;
  urlReturn?: string;
  urlStatus?: string;
  channel?: number;
}

export interface P24TransactionResponse {
  data: {
    token: string;
  };
  responseCode: number;
  message?: string;
}

export interface P24VerificationResponse {
  data: {
    status: string;
    orderId: number;
  };
  responseCode: number;
  message?: string;
}

export interface P24SignatureData {
  sessionId: string;
  merchantId: number;
  amount: number;
  currency: string;
  crc: string;
}

export interface P24SignatureVerificationData {
  sessionId: string;
  orderId: number;
  amount: number;
  currency: string;
  crc: string;
}

export interface P24TransactionBySessionIdResponse {
  data: {
    statement: string;
    orderId: number;
    sessionId: string;
    status: string;
    amount: number;
    currency: string;
    date: string;
    dateOfTransaction: string;
    clientEmail: string;
    accountMD5: string;
    paymentMethod: string;
    description: string;
    clientName: string;
    clientAddres: string;
    clientCity: string;
    clientPostcode: string;
    batchId: number;
    fee: number;
  };
  responseCode: number;
}

/**
 * P24 webhook payload structure
 * Received when P24 sends payment status notifications
 */
export interface P24WebhookPayload {
  merchantId: number;
  posId: number;
  sessionId: string;
  amount: number;
  originAmount: number;
  currency: string;
  orderId: number;
  methodId: number;
  statement: string;
  sign: string;
}

/**
 * BLIK API response structure
 */
export interface P24BlikResponse {
  responseCode: number;
  data: {
    orderId: number;
    message: string;
  };
}

/**
 * BLIK charge by code request data
 */
export interface P24BlikChargeByCodeData {
  token: string;
  blikCode: string;
}

/**
 * P24 Refund Request Data
 */
export interface P24RefundRequestData {
  requestId: string;
  refunds: Array<{
    orderId: number;
    sessionId: string;
    amount: number;
    description?: string;
  }>;
  refundsUuid: string;
  urlStatus?: string;
}

/**
 * P24 Refund Response Data
 */
export interface P24RefundResponseData {
  data: Array<{
    orderId: number;
    sessionId: string;
    amount: number;
    description: string;
    status: boolean;
    message: string;
  }>;
  responseCode: number;
}

export interface BlikOptions extends P24Options {
  enable_one_click?: boolean;
}

export interface BlikTransaction extends P24Transaction {
  blikCode?: string;
  blikType?: "BLIK_CODE" | "BLIK_ONE_CLICK";
  blikUid?: string;
  blikLevel0?: string;
}

export enum PaymentProviderKeys {
  P24_PROVIDER = "p24-provider",
  P24_BLIK = "p24-blik",
  P24_CARDS = "p24-cards",
}

export const ErrorCodes = {
  PAYMENT_INTENT_UNEXPECTED_STATE: "payment_intent_unexpected_state",
} as const;

export const ErrorIntentStatus = {
  CANCELED: "canceled",
  SUCCEEDED: "succeeded",
} as const;
