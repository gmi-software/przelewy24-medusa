export interface P24PsuData {
  IP: string;
  userAgent: string;
}

export interface P24Options {
  merchant_id: string;
  pos_id: string;
  api_key: string;
  crc: string;
  sandbox: boolean;
  frontend_url: string;
  backend_url: string;
  debug?: boolean;
}

export interface P24ServiceOptions extends P24Options {
  channel?: number;
  method_id?: number;
  white_label?: boolean;
}

export interface P24PaymentIntentOptions {
  channel?: number;
  method_id?: number;
  description?: string;
  white_label?: boolean;
}

export interface P24CardData {
  means: {
    referenceNumber: {
      id: string;
      securityCode?: string;
    };
  };
  transactionType: string;
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
  /** Also receives the additional BLIK notification, including rejections. */
  urlCardPaymentNotification?: string;
  channel?: number;
  method?: number;
  regulationAccept?: boolean;
  cardData?: P24CardData;
  additional?: {
    PSU?: P24PsuData;
  };
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

export interface P24PaymentMethodListItem {
  id: number;
  name: string;
  group: string;
  subgroup?: string;
  status?: boolean;
  imgUrl?: string;
  mobileImgUrl?: string;
  mobile?: boolean;
}

export interface P24PaymentMethodsResponse {
  data: P24PaymentMethodListItem[];
  responseCode: number;
  message?: string;
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

export interface P24CardPaymentNotificationPayload {
  merchantId: number;
  posId: number;
  sessionId: string;
  orderId: number;
  amount: number;
  currency: string;
  refId?: string;
  bin?: string;
  mask?: string;
  cardType?: string;
  cardDate?: string;
  hash?: string;
  sign: string;
  status?: string;
}

/**
 * Additional BLIK notification sent to `urlCardPaymentNotification` once the
 * BLIK transaction is resolved — unlike `urlStatus`, also for rejections.
 * `result` is hashed exactly as received, so it stays an opaque record.
 */
export interface P24BlikNotificationPayload {
  orderId: number;
  sessionId: string;
  method: number;
  result: Record<string, unknown>;
  sign: string;
}

export interface P24BlikResponse {
  responseCode: number;
  data: {
    orderId: number;
    message: string;
  };
}

export interface P24CardChargeResponse {
  responseCode: number;
  data: {
    orderId: number;
    redirectUrl?: string;
    message?: string;
  };
  message?: string;
}

export interface P24CardInfoResponse {
  responseCode: number;
  data: {
    refId: string;
    bin: string;
    mask: string;
    cardType: string;
    cardDate: string;
    hash: string;
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

export interface BlikOptions extends P24ServiceOptions {
  enable_one_click?: boolean;
}

export interface CardsOptions extends P24ServiceOptions {
  card_channel?: number;
}

export interface VisaMobileOptions extends P24ServiceOptions {
  visa_mobile_method_id?: number;
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
  P24_VISA_MOBILE = "p24-visa-mobile",
}

export {
  P24_WEBHOOK_ALLOWED_CIDRS,
  P24_WEBHOOK_ALLOWED_IPS,
} from "../../../utils/p24-webhook-ips";

export const DEFAULT_CARD_CHANNEL = 4096;
export const DEFAULT_BLIK_CHANNEL = 64;
export const DEFAULT_VISA_MOBILE_METHOD_ID = 198;

export const ErrorCodes = {
  PAYMENT_INTENT_UNEXPECTED_STATE: "payment_intent_unexpected_state",
} as const;

export const ErrorIntentStatus = {
  CANCELED: "canceled",
  SUCCEEDED: "succeeded",
} as const;
