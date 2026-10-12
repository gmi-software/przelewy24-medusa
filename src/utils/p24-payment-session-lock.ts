import { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";

/**
 * Serialises the plugin's writes to one payment session (BLIK charge and
 * rejection notification) across every instance sharing the locking provider.
 */
export function withP24PaymentSessionLock<T>(
  scope: Pick<MedusaContainer, "resolve">,
  paymentSessionId: string,
  job: () => Promise<T>,
): Promise<T> {
  return scope
    .resolve(Modules.LOCKING)
    .execute(`p24-payment-session:${paymentSessionId}`, job);
}
