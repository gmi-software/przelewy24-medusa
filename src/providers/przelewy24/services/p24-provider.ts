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
      channel: 0, // All channels - shows all available payment methods
      description: "Payment via Przelewy24 - All payment methods",
    };
  }

  protected getProviderKey(): string {
    return PaymentProviderKeys.P24_PROVIDER;
  }
}

export default P24ProviderService;
