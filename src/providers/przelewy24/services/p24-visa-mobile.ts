import P24Base from "../core/p24-base";
import {
  DEFAULT_VISA_MOBILE_METHOD_ID,
  P24PaymentIntentOptions,
  PaymentProviderKeys,
  VisaMobileOptions,
} from "../types";
import { coerceSandbox } from "../../../utils/coerce-sandbox";

class P24VisaMobileService extends P24Base {
  static identifier = PaymentProviderKeys.P24_VISA_MOBILE;

  private readonly visaMobileOptions_: VisaMobileOptions;

  constructor(cradle: Record<string, unknown>, options: VisaMobileOptions) {
    const methodId = options.visa_mobile_method_id ?? DEFAULT_VISA_MOBILE_METHOD_ID;

    if (!Number.isFinite(methodId) || methodId <= 0) {
      throw new Error(
        "Invalid `visa_mobile_method_id` in P24 Visa Mobile provider options",
      );
    }

    const normalizedOptions: VisaMobileOptions = {
      ...options,
      sandbox: coerceSandbox(options.sandbox),
      visa_mobile_method_id: methodId,
      white_label: options.white_label ?? false,
    };

    super(cradle, normalizedOptions);
    this.visaMobileOptions_ = normalizedOptions;
  }

  get paymentIntentOptions(): P24PaymentIntentOptions {
    const options: P24PaymentIntentOptions = {
      method_id: this.visaMobileOptions_.visa_mobile_method_id,
      description: "Payment via Przelewy24 - Visa Mobile",
      white_label: this.visaMobileOptions_.white_label ?? false,
    };

    if (
      this.visaMobileOptions_.channel != null &&
      this.visaMobileOptions_.channel > 0
    ) {
      options.channel = this.visaMobileOptions_.channel;
    }

    return options;
  }

  protected getProviderKey(): string {
    return PaymentProviderKeys.P24_VISA_MOBILE;
  }

  protected getTransactionTimeLimit(): number | undefined {
    const minutes = this.options.redirect_time_limit_minutes;
    return minutes && minutes > 0 ? minutes : undefined;
  }
}

export default P24VisaMobileService;
