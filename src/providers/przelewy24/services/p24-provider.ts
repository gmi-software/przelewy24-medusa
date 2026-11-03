import P24Base from "../core/p24-base";
import {
  P24PaymentIntentOptions,
  PaymentProviderKeys,
  P24Options,
} from "../types";

class P24ProviderService extends P24Base {
  static identifier = PaymentProviderKeys.P24_PROVIDER;

  constructor(cradle: Record<string, unknown>, options: P24Options) {
    super(cradle, options);
  }

  get paymentIntentOptions(): P24PaymentIntentOptions {
    return {
      description: "Payment via Przelewy24 - All payment methods",
    };
  }

  protected getProviderKey(): string {
    return PaymentProviderKeys.P24_PROVIDER;
  }

  protected getTransactionTimeLimit(): number | undefined {
    const minutes = this.options.redirect_time_limit_minutes;
    return minutes && minutes > 0 ? minutes : undefined;
  }
}

export default P24ProviderService;
