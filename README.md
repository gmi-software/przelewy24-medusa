# Przelewy24 Payments for Medusa

A comprehensive payment provider plugin that enables [Przelewy24](https://www.przelewy24.pl/) payments on [Medusa](https://medusajs.com/) V2 projects.

<p align="center">
  <a href="https://gmi.software/">
    <img src="https://img.shields.io/badge/Website-gmi.software-blue?style=flat&logo=world" alt="Website" />
  </a>

  <a href="https://pl.linkedin.com/company/gmisoftware">
    <img src="https://img.shields.io/badge/LinkedIn-gmisoftware-blue?style=flat&logo=linkedin" alt="LinkedIn" />
  </a>
</p>

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
  - [Configuration Options](#configuration-options)
  - [Environment Variables](#environment-variables)
- [Usage](#usage)
- [Client-Side Integration](#client-side-integration)
- [Supported Payment Methods](#supported-payment-methods)
- [Payment Flows](#payment-flows)
- [Webhook Configuration](#webhook-configuration)
- [Extending the Plugin](#extending-the-plugin)
- [Local Development and Customization](#local-development-and-customization)
- [License](#license)

## Features

- **Multiple Payment Methods**: Supports a wide range of Przelewy24 payment methods including:

  - BLIK (Regular and One-Click)
  - Credit/Debit Cards
  - Bank Transfers
  - White Label Integration

- **Modular Architecture**: Multiple services in a single module provider for easy management.

- **Webhook Support**: Full support for Przelewy24 webhooks for real-time payment status updates.

- **TypeScript Support**: Full TypeScript implementation with proper types.

- **Sandbox Mode**: Built-in sandbox support for testing.

> [!WARNING] > _This plugin has not been tested on a live store. Please conduct thorough testing before using it in a production environment. GMI Software is not responsible for any missed or failed payments resulting from the use of this plugin. If you encounter any issues, please report them [here](https://github.com/gmi-software/p24-medusa-plugin/issues)._

## Prerequisites

- Medusa server v2.4.0 or later
- Node.js v20 or later
- A [Przelewy24](https://www.przelewy24.pl/) merchant account with API credentials.

> [!NOTE] > _You can get your API credentials from your Przelewy24 merchant panel_

## Installation

```bash
yarn add p24-medusa-plugin
```

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

## Configuration Options

| Option         | Description                            | Required | Default                 |
| -------------- | -------------------------------------- | -------- | ----------------------- |
| `merchant_id`  | P24 Merchant ID                        | Yes      | -                       |
| `pos_id`       | P24 POS ID                             | Yes      | -                       |
| `api_key`      | P24 API Key                            | Yes      | -                       |
| `crc`          | P24 CRC Key for signature verification | Yes      | -                       |
| `sandbox`      | Enable sandbox mode                    | No       | `false`                 |
| `frontend_url` | Frontend URL for customer redirects    | No       | `http://localhost:3000` |
| `backend_url`  | Backend URL for webhook notifications  | No       | `http://localhost:9000` |

## Environment Variables

Create or update your `.env` file with the following variables:

```bash
# P24 Configuration
P24_MERCHANT_ID=your_merchant_id
P24_POS_ID=your_pos_id
P24_API_KEY=your_api_key
P24_CRC=your_crc_key

# URL Configuration
FRONTEND_URL=https://your-frontend-domain.com
BACKEND_URL=https://your-backend-domain.com
```

## Usage

Once installed and configured, the Przelewy24 payment methods will be available in your Medusa admin. To enable them, log in to your Medusa Admin, browse to Settings > Regions, add or edit a region and select the desired P24 providers from the dropdown.

Make sure that the selected payment methods are enabled in your Przelewy24 merchant panel as well.

### Client-Side Integration

To integrate with your storefront, you'll need to implement the payment flow according to Przelewy24's and Medusa's documentation. Here's a basic example:

#### BLIK Payment

BLIK payments use a two-phase flow:

**Phase 1: Create Payment Session**

```typescript
// Create payment session for BLIK
const paymentSession = await medusa.payment.createPaymentSession({
  provider_id: "p24-blik",
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
// Call internal API to process BLIK code
const blikResponse = await fetch("/admin/plugin/blik", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    token: paymentSession.data.token, // Token from payment session
    blikCode: "123456", // 6-digit BLIK code from user
  }),
});
```

#### Card Payment

```typescript
// Create payment session for cards
const paymentSession = await medusa.payment.createPaymentSession({
  provider_id: "p24-cards",
  amount: 10000, // 100.00 PLN in grosze
  currency_code: "PLN",
  data: {
    country: "PL", // Country code (defaults to "PL" if not provided)
    language: "pl", // Language code (defaults to "pl" if not provided)
  },
  context: {
    email: "customer@example.com",
    billing_address: {
      country_code: "PL",
    },
  },
});

// Redirect user to payment URL
window.location.href = paymentSession.data.redirect_url;
```

#### General P24 Payment

```typescript
// Create payment session for general P24
const paymentSession = await medusa.payment.createPaymentSession({
  provider_id: "p24-general",
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

The plugin currently supports the following Przelewy24 payment methods:

| Payment Method | Provider ID                   |
| -------------- | ----------------------------- |
| BLIK           | `pp_p24-blik_p24-blik`        |
| Cards          | `pp_p24-cards_p24-cards`      |
| General P24    | `pp_p24-provider_p24-general` |

## Payment Flows

### 1. BLIK Payment Flow

1. **Phase 1**: Frontend creates payment session via `initiatePayment`
2. **Phase 2**: Frontend collects BLIK code (6 digits) from customer
3. **Phase 3**: Frontend calls internal API `/admin/plugin/blik` with BLIK code
4. **Phase 4**: Backend calls P24 BLIK API to charge the payment
5. **Phase 5**: Customer confirms payment on mobile device
6. **Phase 6**: P24 sends webhook notification confirming payment
7. **Phase 7**: Order is completed

**Note**: BLIK payments don't use redirect URLs. The entire flow happens through API calls.

### 2. Card Payment Flow

1. Customer is redirected to P24 card payment page
2. Customer enters card details
3. Payment is processed
4. Customer is redirected back to store
5. Webhook notification confirms payment

### 3. General P24 Flow

1. Customer is redirected to P24 payment selection
2. Customer chooses payment method (bank transfer, etc.)
3. Payment is processed through chosen method
4. Customer is redirected back to store
5. Webhook notification confirms payment

## Webhook Configuration

### Webhook URLs

The plugin provides webhook endpoints for each provider:

- **BLIK**: `{backend_url}/hooks/payment/p24-blik_p24-medusa-plugin`
- **Cards**: `{backend_url}/hooks/payment/p24-cards_p24-medusa-plugin`
- **General**: `{backend_url}/hooks/payment/p24-provider_p24-medusa-plugin`

### Return URL

- **Return URL**: `{frontend_url}`

Configure these URLs in your P24 merchant panel.

**Note**: The webhook URLs follow Medusa's pattern: `{identifier}_{provider}` where:

- `identifier` is the service's static identifier (e.g., `p24-blik`, `p24-cards`, `p24-provider`)
- `provider` is the package name (`p24-medusa-plugin`)

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

## Local development and customization

In case you want to customize and test the plugin locally, refer to the [Medusa Plugin docs](https://docs.medusajs.com/learn/fundamentals/plugins/create#3-publish-plugin-locally-for-development-and-testing).

## License

MIT License

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request
