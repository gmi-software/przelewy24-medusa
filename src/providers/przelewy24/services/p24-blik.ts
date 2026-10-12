import P24Base from "../core/p24-base";
import { P24_BLIK_NOTIFICATION_PATH } from "../core/p24-blik-notification";
import {
  BlikOptions,
  DEFAULT_BLIK_CHANNEL,
  P24BlikNotificationPayload,
  P24PaymentIntentOptions,
  PaymentProviderKeys,
} from "../types";
import { coerceSandbox } from "../../../utils/coerce-sandbox";

class P24BlikService extends P24Base {
  static identifier = PaymentProviderKeys.P24_BLIK;

  private readonly blikOptions_: BlikOptions;

  constructor(cradle: Record<string, unknown>, options: BlikOptions) {
    const normalizedOptions: BlikOptions = {
      ...options,
      sandbox: coerceSandbox(options.sandbox),
      channel: options.channel ?? DEFAULT_BLIK_CHANNEL,
      white_label: options.white_label ?? true,
    };

    super(cradle, normalizedOptions);
    this.blikOptions_ = normalizedOptions;
  }

  get paymentIntentOptions(): P24PaymentIntentOptions {
    return {
      channel: this.blikOptions_.channel ?? DEFAULT_BLIK_CHANNEL,
      description: "Payment via Przelewy24 - BLIK",
      white_label: this.blikOptions_.white_label ?? true,
    };
  }

  protected getProviderKey(): string {
    return PaymentProviderKeys.P24_BLIK;
  }

  protected getCardPaymentNotificationUrl(): string {
    return `${this.options_.backend_url}${P24_BLIK_NOTIFICATION_PATH}`;
  }

  async chargeBlikPayment(token: string, blikCode: string) {
    return this.p24Api.chargeBlikByCode({
      token,
      blikCode,
    });
  }

  isAllowedNotificationSource(sourceIp: string | undefined): boolean {
    return this.p24Api.isAllowedWebhookIp(sourceIp);
  }

  verifyBlikNotificationSignature(
    payload: P24BlikNotificationPayload,
  ): boolean {
    const { sign, ...signed } = payload;
    return this.p24Api.verifyBlikNotificationSignature(signed, sign);
  }
}

export default P24BlikService;
