/**
 * Przelewy24 (P24) Payment Module Provider for Medusa
 *
 * This module provider exports multiple payment services following the Stripe pattern:
 * - P24BlikService: BLIK payments (Channel 64, Method 181)
 * - P24CardsService: Card payments (Channel 1)
 * - P24ProviderService: General P24 payments (Channel 0)
 *
 * Each service can be configured separately in medusa-config.ts with different IDs
 * to create multiple provider instances with different options.
 */
import { ModuleProvider, Modules } from "@medusajs/framework/utils";
import P24BlikService from "./services/p24-blik";
import P24CardsService from "./services/p24-cards";
import P24ProviderService from "./services/p24-provider";

const services = [P24BlikService, P24CardsService, P24ProviderService];

export default ModuleProvider(Modules.PAYMENT, {
  services,
});
