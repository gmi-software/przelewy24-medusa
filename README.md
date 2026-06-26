<img width="1024" height="342" alt="Przelewy24 Medusa" src="./docs/static/img/readme-banner.png" />

<div align="center">

A comprehensive [Przelewy24](https://www.przelewy24.pl/) payment provider plugin for [Medusa.js 2.0](https://medusajs.com/) — BLIK, cards, Visa Mobile, and general P24 redirect flows.

[![npm version](https://img.shields.io/npm/v/@gmisoftware/przelewy24-payments-medusa.svg)](https://www.npmjs.com/package/@gmisoftware/przelewy24-payments-medusa)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)
[![Medusa v2](https://img.shields.io/badge/Medusa-v2-000000.svg)](https://medusajs.com/)

[Features](#features) • [Installation](#installation) • [Configuration](#configuration) • [Usage](#usage) • [Payment Flows](#payment-flows) • [Webhooks](#webhook-configuration)

</div>

---

## Features

- ✅ **Multiple Payment Methods** — BLIK (regular and one-click), credit/debit cards, Visa Mobile, bank transfers, and general P24 redirect
- ✅ **White-Label Integration** — Card 2.0 iframe and BLIK charge flows without leaving your storefront
- ✅ **Webhook Support** — Real-time payment status updates with signature verification
- ✅ **Modular Architecture** — Multiple services in a single module provider for easy management
- ✅ **TypeScript** — Full TypeScript implementation with proper types
- ✅ **Sandbox Mode** — Built-in sandbox support for testing

> [!WARNING]
> This plugin has not been tested on a live store. Please conduct thorough testing before using it in a production environment. GMI Software is not responsible for any missed or failed payments resulting from the use of this plugin. If you encounter any issues, please report them on the [GitHub issues tracker](https://github.com/gmi-software/przelewy24-medusa/issues).

---

## Prerequisites

- Medusa server v2.4.0 or later
- Node.js v20 or later
- A [Przelewy24](https://www.przelewy24.pl/) merchant account with API credentials

> [!NOTE]
> You can get your API credentials from your Przelewy24 merchant panel.

---

## Installation

```bash
yarn add @gmisoftware/przelewy24-payments-medusa
```

---

## Configuration

Add the provider to the `@medusajs/payment` module in your `medusa-config.ts` file:

```typescript
import { Modules } from "@medusajs/framework/utils";

module.exports = defineConfig({
  modules: [
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve:
              "@gmisoftware/przelewy24-payments-medusa/providers/przelewy24",
            id: "przelewy24",
            options: {
              api_key: process.env.P24_API_KEY,
              merchant_id: process.env.P24_MERCHANT_ID,
              pos_id: process.env.P24_POS_ID,
              crc: process.env.P24_CRC,
              sandbox: process.env.P24_IS_SANDBOX,
              frontend_url: process.env.MEDUSA_STORE_URL,
              backend_url: process.env.MEDUSA_BACKEND_URL,
            },
          },
        ],
      },
    },
  ],
  plugins: ["@gmisoftware/przelewy24-payments-medusa"],
});
```

### Configuration Options

| Option                  | Description                                              | Required | Default                 |
| ----------------------- | -------------------------------------------------------- | -------- | ----------------------- |
| `merchant_id`           | P24 Merchant ID                                          | Yes      | -                       |
| `pos_id`                | P24 POS ID                                               | Yes      | -                       |
| `api_key`               | P24 API Key                                              | Yes      | -                       |
| `crc`                   | P24 CRC Key for signature verification                   | Yes      | -                       |
| `sandbox`               | Enable sandbox mode (`true`/`false` or `"true"`/`"false"`) | No       | `false`                 |
| `card_channel`          | P24 channel for card-only registration                   | No       | `4096`                  |
| `visa_mobile_method_id` | P24 method id for Visa Mobile                            | No       | `198`                   |
| `frontend_url`          | Frontend URL for customer redirects                      | No       | `http://localhost:3000` |
| `backend_url`           | Backend URL for webhook notifications                    | No       | `http://localhost:9000` |

### Environment Variables

Create or update your `.env` file with the following variables:

```bash
# P24 Configuration
P24_MERCHANT_ID=your_merchant_id
P24_POS_ID=your_pos_id
P24_API_KEY=your_api_key
P24_CRC=your_crc_key

# URL Configuration (use the same names as medusa-config.ts)
MEDUSA_STORE_URL=https://your-frontend-domain.com
MEDUSA_BACKEND_URL=https://your-backend-domain.com   # public HTTPS — P24 webhooks hit this host
P24_IS_SANDBOX=false
```

---

## Usage

Once installed and configured, the Przelewy24 payment methods will be available in your Medusa admin. To enable them, log in to your Medusa Admin, browse to Settings > Regions, add or edit a region and select the desired P24 providers from the dropdown.

Make sure that the selected payment methods are enabled in your Przelewy24 merchant panel as well.

### Client-Side Integration

To integrate with your storefront, implement the payment flow according to Przelewy24's and Medusa's documentation. Here are basic examples:

#### BLIK Payment

BLIK payments use a two-phase flow:

**Phase 1: Create Payment Session**

```typescript
// Create payment session for BLIK
const paymentSession = await medusa.payment.createPaymentSession({
  provider_id: "pp_p24-blik_przelewy24",
  amount: 10000, // 100.00 PLN in grosze
  currency_code: "PLN",
  data: {
    country: "PL", // Country code (defaults to "PL" if not provided)
    language: "pl", // Language code (defaults to "pl" if not provided)
  },
  context: {
    email: "customer@example.com",
  },
});

// Response includes session_id and token, but no redirect_url
console.log(paymentSession.data.session_id); // Use this for BLIK processing
```

**Phase 2: Process BLIK Code**

```typescript
// Store API (publishable key + cart context)
const blikResponse = await fetch("/store/payments/blik/charge", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-publishable-api-key": publishableKey,
  },
  body: JSON.stringify({
    token: paymentSession.data.token,
    blikCode: "123456",
    payment_session_id: paymentSession.id,
  }),
});
```

> Legacy route `POST /payments/blik` remains as a deprecated wrapper.

#### Card Payment 2.0 (white-label iframe)

Per [P24 Card Payment 2.0 docs](https://developers.przelewy24.pl/extended/index.php?pl#tag/Inicjalizacja-formularza):

```typescript
// 1) Create payment session — returns tokenization fields (no transaction register yet)
const { payment_session } = await medusa.store.cart.createPaymentSession(cartId, {
  provider_id: "pp_p24-cards_przelewy24",
});

const { merchant_id, session_id, card_tokenization_sign } =
  payment_session.data;

// 2) Load P24 Card 2.0 SDK and render iframe
// https://{sandbox|secure}.przelewy24.pl/js/cardTokenizationIframe.min.js
// new Przelewy24CardTokenization(merchant_id, session_id, card_tokenization_sign)
//   .render("form", "#container", { lang: "pl", ... })
// On Pay: .tokenize("temporary") → listen for postMessage success with data.refId

// 3) Register with refId, then run P24 whitelabel charge script in the browser
const cardResponse = await fetch("/store/payments/card/charge", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-publishable-api-key": publishableKey,
  },
  body: JSON.stringify({
    ref_id: refIdFromTokenization,
    payment_session_id: payment_session.id,
  }),
});

const { token, chargeScriptUrl } = await cardResponse.json();
// 4) Load chargeScriptUrl and run Przelewy24CardWhileLabelHandler (3DS in merchant modal)
// 5) Poll POST /store/carts/{cartId}/complete until type === "order"
// 6) Capture happens via P24 webhook to urlStatus (not via a separate confirm API)
```

#### Visa Mobile (redirect with pre-selected method)

```typescript
// 1) Create payment session — returns redirect_url with method 198 pre-selected
const { payment_session } = await medusa.store.cart.createPaymentSession(cartId, {
  provider_id: "pp_p24-visa-mobile_przelewy24",
});

// 2) Redirect customer to P24 Visa Mobile flow
window.location.href = payment_session.data.redirect_url;

// 3) Customer completes payment on P24 hosted page
// 4) Return to frontend_url / return_url
// 5) Capture happens via P24 webhook to urlStatus (not via a separate confirm API)
```

#### Transaction status (poll timeout fallback)

```typescript
await fetch("/store/payments/transaction/status", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    session_id: payment_session.data.session_id,
    provider_id: payment_session.provider_id,
  }),
});
```

#### General P24 Payment

```typescript
// Create payment session for general P24
const paymentSession = await medusa.payment.createPaymentSession({
  provider_id: "pp_p24-provider_przelewy24",
  amount: 10000,
  currency_code: "PLN",
  data: {
    country: "PL", // Country code (defaults to "PL" if not provided)
    language: "pl", // Language code (defaults to "pl" if not provided)
  },
  context: {
    email: "customer@example.com",
  },
});

// Redirect user to P24 payment selection
window.location.href = paymentSession.data.redirect_url;
```

### Supported Payment Methods

| Payment Method | Provider ID                      | Notes                            |
| -------------- | ---------------------------------- | -------------------------------- |
| BLIK           | `pp_p24-blik_przelewy24`           | White-label, channel 64          |
| Cards          | `pp_p24-cards_przelewy24`          | White-label iframe, channel 4096 |
| Visa Mobile    | `pp_p24-visa-mobile_przelewy24`    | Redirect with method `198`       |
| General P24    | `pp_p24-provider_przelewy24`       | Redirect to P24 method picker    |

---

## Payment Flows

### 1. BLIK (white-label)

1. Create payment session (`initiatePayment`) → `token`, `session_id`
2. Customer enters 6-digit BLIK code
3. `POST /store/payments/blik/charge` → P24 `chargeByCode`
4. Customer approves in banking app
5. Storefront polls `POST /store/carts/{id}/complete` until order is created
6. P24 sends webhook to `urlStatus` → verify + capture → `payment_collection.completed_at`

BLIK does not use redirect URLs.

### 2. Cards (P24 Card 2.0 white-label)

1. Create payment session → tokenization fields only (`merchant_id`, `session_id`, `card_tokenization_sign`, `amount_grosze`) — **no** `transaction/register` yet
2. Load `cardTokenizationIframe.min.js`, render iframe; regulation checkbox is **inside** the P24 widget
3. On Pay: `tokenize("temporary")` → `refId` via postMessage
4. `POST /store/payments/card/charge` with `ref_id` → `transaction/register` + returns `chargeScriptUrl`
5. Browser runs `Przelewy24CardWhileLabelHandler` (3DS in merchant UI)
6. Storefront polls `POST /store/carts/{id}/complete` until order is created
7. P24 webhook → verify + capture

See [P24 Card 2.0 docs](https://developers.przelewy24.pl/extended/index.php?pl#tag/Inicjalizacja-formularza).

### 3. Visa Mobile (redirect with pre-selected method)

1. Create payment session → `redirect_url` (P24 `transaction/register` includes `method: 198`)
2. Customer pays on P24 hosted Visa Mobile page
3. Return to `frontend_url` / `return_url`
4. Webhook confirms payment

### 4. General P24 (redirect)

1. Create payment session → `redirect_url`
2. Customer pays on P24 hosted page
3. Return to `frontend_url` / `return_url`
4. Webhook confirms payment

### Completion model (all white-label methods)

| Step                         | Mechanism                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Order creation               | Storefront polls `complete`; Medusa `authorizePayment` queries P24 API; or `complete-captured-carts-backstop` (Medusa, every 2 min) when payment is already captured |
| Capture + `completed_at`     | P24 webhook to `urlStatus`, or `reconcile-p24-payments` job (every 5 min)                                                                            |

**Do not** add a separate store “confirm” route to replace webhooks. Production capture is webhook-driven.

---

## Webhook Configuration

### Webhook URLs (auto-registered)

On each `transaction/register`, the plugin sets:

```text
urlStatus: {backend_url}/hooks/payment/{service-identifier}_{payment-module-id}
```

With `payment-module` config `id: "przelewy24"` (recommended):

| Method      | Webhook URL                                              |
| ----------- | -------------------------------------------------------- |
| Cards       | `{backend_url}/hooks/payment/p24-cards_przelewy24`       |
| BLIK        | `{backend_url}/hooks/payment/p24-blik_przelewy24`         |
| Visa Mobile | `{backend_url}/hooks/payment/p24-visa-mobile_przelewy24` |
| General     | `{backend_url}/hooks/payment/p24-provider_przelewy24`    |

Medusa route: `POST /hooks/payment/:provider` → `getWebhookActionAndData` → `processPaymentWorkflow`.

- **`backend_url`** must be the **Medusa** server URL (public HTTPS in production), not the storefront.
- Webhooks are registered **per transaction**; you do not paste these into the P24 panel for white-label flows.
- **Return URL** for redirects: `{frontend_url}` (and cart-specific `return_url` in session data).

### Production checklist

- [ ] `backend_url` reachable from the internet (P24 cannot call `localhost`)
- [ ] `crc` matches merchant panel (signature verification)
- [ ] P24 webhook source IPs allowed (see `P24_WEBHOOK_ALLOWED_IPS`; sandbox allows localhost)
- [ ] Region enables correct `pp_p24-*_przelewy24` providers

### Local development

Without a tunnel, webhooks will not arrive. Orders may still be created via poll `complete`, but `payment_collection` can remain `not_paid` until the **reconcile** job runs (~5 min). Use ngrok + public `backend_url` for full webhook testing.

```bash
yarn build && yalc publish --push
```

---

## Extending the Plugin

To add support for additional Przelewy24 payment methods, create a new service in `src/providers/przelewy24/services` that extends the `P24Base` class:

```typescript
import P24Base from "../core/p24-base";
import { PaymentOptions } from "../types";

class P24NewMethodService extends P24Base {
  static identifier = "p24-new-method";

  get paymentCreateOptions(): PaymentOptions {
    return {
      method: "new_method",
    };
  }
}

export default P24NewMethodService;
```

Make sure to replace `new_method` with the actual Przelewy24 payment method ID.

Export your new service from `src/providers/przelewy24/services/index.ts`. Then add your new service to the list of services in `src/providers/przelewy24/index.ts`.

---

## Local Development

To customize and test the plugin locally, refer to the [Medusa Plugin docs](https://docs.medusajs.com/learn/fundamentals/plugins/create#3-publish-plugin-locally-for-development-and-testing).

```bash
yarn install
yarn build
yarn test
```

---

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

---

## License

MIT © [GMI Software](https://gmi.software)

---

<div align="center">

Made with ❤️ by [gmi.software](https://gmi.software)

</div>
