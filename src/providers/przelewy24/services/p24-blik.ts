import P24Base from "../core/p24-base";
import {
  P24PaymentIntentOptions,
  PaymentProviderKeys,
  BlikOptions,
} from "../types";

class P24BlikService extends P24Base {
  static identifier = PaymentProviderKeys.P24_BLIK;

  constructor(cradle: Record<string, unknown>, options: BlikOptions) {
    super(cradle, options);
  }

  get paymentIntentOptions(): P24PaymentIntentOptions {
    return {
      channel: 64, // BLIK channel - BLIK payments only
      description: "Payment via Przelewy24 - BLIK",
    };
  }

  protected getProviderKey(): string {
    return PaymentProviderKeys.P24_BLIK;
  }

  async chargeBlikPayment(token: string, blikCode: string) {
    return this.p24Api.chargeBlikByCode({
      token,
      blikCode,
    });
  }
}

export default P24BlikService;
