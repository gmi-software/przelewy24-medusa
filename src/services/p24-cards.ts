import P24Base from "../core/p24-base";
import {
  P24PaymentIntentOptions,
  PaymentProviderKeys,
  P24Options,
} from "../types";

class P24CardsService extends P24Base {
  static identifier = PaymentProviderKeys.P24_CARDS;

  constructor(cradle: Record<string, unknown>, options: P24Options) {
    super(cradle, options);
  }

  get paymentIntentOptions(): P24PaymentIntentOptions {
    return {
      channel: 1, // Cards channel - credit/debit cards only
      description: "Payment via Przelewy24 - Credit/Debit Cards",
    };
  }

  protected getProviderKey(): string {
    return PaymentProviderKeys.P24_CARDS;
  }
}

export default P24CardsService;
