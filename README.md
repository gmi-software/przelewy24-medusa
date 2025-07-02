<p align="center">
  <a href="https://www.medusajs.com">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://user-images.githubusercontent.com/59018053/229103275-b5e482bb-4601-46e6-8142-244f531cebdb.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://user-images.githubusercontent.com/59018053/229103726-e5b529a3-9b3f-4970-8a1f-c6af37f087bf.svg">
    <img alt="Medusa logo" src="https://user-images.githubusercontent.com/59018053/229103726-e5b529a3-9b3f-4970-8a1f-c6af37f087bf.svg">
    </picture>
  </a>
</p>
<h1 align="center">
  Medusa Plugin Starter
</h1>

<h4 align="center">
  <a href="https://docs.medusajs.com">Documentation</a> |
  <a href="https://www.medusajs.com">Website</a>
</h4>

<p align="center">
  Building blocks for digital commerce
</p>
<p align="center">
  <a href="https://github.com/medusajs/medusa/blob/master/CONTRIBUTING.md">
    <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat" alt="PRs welcome!" />
  </a>
    <a href="https://www.producthunt.com/posts/medusa"><img src="https://img.shields.io/badge/Product%20Hunt-%231%20Product%20of%20the%20Day-%23DA552E" alt="Product Hunt"></a>
  <a href="https://discord.gg/xpCwq3Kfn8">
    <img src="https://img.shields.io/badge/chat-on%20discord-7289DA.svg" alt="Discord Chat" />
  </a>
  <a href="https://twitter.com/intent/follow?screen_name=medusajs">
    <img src="https://img.shields.io/twitter/follow/medusajs.svg?label=Follow%20@medusajs" alt="Follow @medusajs" />
  </a>
</p>

## Compatibility

This starter is compatible with versions >= 2.4.0 of `@medusajs/medusa`.

## Getting Started

Visit the [Quickstart Guide](https://docs.medusajs.com/learn/installation) to set up a server.

Visit the [Plugins documentation](https://docs.medusajs.com/learn/fundamentals/plugins) to learn more about plugins and how to create them.

Visit the [Docs](https://docs.medusajs.com/learn/installation#get-started) to learn more about our system requirements.

## What is Medusa

Medusa is a set of commerce modules and tools that allow you to build rich, reliable, and performant commerce applications without reinventing core commerce logic. The modules can be customized and used to build advanced ecommerce stores, marketplaces, or any product that needs foundational commerce primitives. All modules are open-source and freely available on npm.

Learn more about [Medusa's architecture](https://docs.medusajs.com/learn/introduction/architecture) and [commerce modules](https://docs.medusajs.com/learn/fundamentals/modules/commerce-modules) in the Docs.

## Community & Contributions

The community and core team are available in [GitHub Discussions](https://github.com/medusajs/medusa/discussions), where you can ask for support, discuss roadmap, and share ideas.

Join our [Discord server](https://discord.com/invite/medusajs) to meet other community members.

## Other channels

- [GitHub Issues](https://github.com/medusajs/medusa/issues)
- [Twitter](https://twitter.com/medusajs)
- [LinkedIn](https://www.linkedin.com/company/medusajs)
- [Medusa Blog](https://medusajs.com/blog/)

# Przelewy24 (P24) Payment Plugin for Medusa

A comprehensive Przelewy24 payment integration plugin for Medusa e-commerce, supporting BLIK, card payments, and general P24 redirect flow.

## Features

- **Multiple Payment Methods**: BLIK, Cards, and general P24 redirect
- **BLIK Support**: Regular BLIK codes and one-click BLIK
- **White Label Integration**: Support for BLIK white label and card white label
- **Webhook Handling**: Secure webhook verification and processing
- **Modular Architecture**: Multiple services in a single module provider
- **TypeScript Support**: Full TypeScript implementation with proper types

## Installation

```bash
npm install p24-medusa-plugin
# or
yarn add p24-medusa-plugin
```

## Configuration

Add the P24 plugin to your `medusa-config.ts`:

```typescript
import { Modules } from "@medusajs/framework/utils";

module.exports = defineConfig({
  modules: [
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          // P24 Plugin with multiple services
          {
            resolve: "p24-medusa-plugin",
            id: "p24-blik",
            options: {
              merchant_id: process.env.P24_MERCHANT_ID,
              pos_id: process.env.P24_POS_ID,
              api_key: process.env.P24_API_KEY,
              crc: process.env.P24_CRC,
              sandbox: process.env.NODE_ENV !== "production",
              frontend_url: process.env.FRONTEND_URL,
              backend_url: process.env.BACKEND_URL,
              enable_one_click: true, // BLIK-specific option
            },
          },
          {
            resolve: "p24-medusa-plugin",
            id: "p24-cards",
            options: {
              merchant_id: process.env.P24_MERCHANT_ID,
              pos_id: process.env.P24_POS_ID,
              api_key: process.env.P24_API_KEY,
              crc: process.env.P24_CRC,
              sandbox: process.env.NODE_ENV !== "production",
              frontend_url: process.env.FRONTEND_URL,
              backend_url: process.env.BACKEND_URL,
            },
          },
          {
            resolve: "p24-medusa-plugin",
            id: "p24-medusa-plugin",
            options: {
              merchant_id: process.env.P24_MERCHANT_ID,
              pos_id: process.env.P24_POS_ID,
              api_key: process.env.P24_API_KEY,
              crc: process.env.P24_CRC,
              sandbox: process.env.NODE_ENV !== "production",
              frontend_url: process.env.FRONTEND_URL,
              backend_url: process.env.BACKEND_URL,
            },
          },
        ],
      },
    },
  ],
});
```

## Environment Variables

Add the following environment variables to your `.env` file:

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

## Provider Options

### Common Options (All Providers)

| Option         | Description                            | Required | Default                 |
| -------------- | -------------------------------------- | -------- | ----------------------- |
| `merchant_id`  | P24 Merchant ID                        | Yes      | -                       |
| `pos_id`       | P24 POS ID                             | Yes      | -                       |
| `api_key`      | P24 API Key                            | Yes      | -                       |
| `crc`          | P24 CRC Key for signature verification | Yes      | -                       |
| `sandbox`      | Enable sandbox mode                    | No       | `false`                 |
| `frontend_url` | Frontend URL for customer redirects    | No       | `http://localhost:3000` |
| `backend_url`  | Backend URL for webhook notifications  | No       | `http://localhost:9000` |

### BLIK Provider Additional Options

| Option             | Description                    | Required | Default |
| ------------------ | ------------------------------ | -------- | ------- |
| `enable_one_click` | Enable one-click BLIK payments | No       | `false` |

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

## Usage Examples

### Frontend Integration

### Data Parameters

The plugin accepts the following parameters in the `data` object:

| Parameter  | Type   | Required | Default | Description                            |
| ---------- | ------ | -------- | ------- | -------------------------------------- |
| `country`  | string | No       | `"PL"`  | Country code (e.g., "PL", "DE", "EN")  |
| `language` | string | No       | `"pl"`  | Language code (e.g., "pl", "en", "de") |

**Note**: Both parameters are optional and will fall back to Polish defaults if not provided.

#### BLIK Payment

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
    // For regular BLIK, collect code from user
    extra: {
      blik_code: "123456", // 6-digit BLIK code
    },
  },
});

// For one-click BLIK
const oneClickSession = await medusa.payment.createPaymentSession({
  provider_id: "p24-blik",
  amount: 10000,
  currency_code: "PLN",
  data: {
    country: "PL",
    language: "pl",
  },
  context: {
    email: "customer@example.com",
    extra: {
      blik_uid: "user_blik_uid", // One-click BLIK UID
    },
  },
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

## Payment Flow

### 1. BLIK Payment Flow

1. Customer enters BLIK code (6 digits)
2. Payment session is created with BLIK code
3. Customer confirms payment on mobile device
4. Webhook notification confirms payment
5. Order is completed

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

## API Reference

### Service Identifiers

The plugin exports multiple services with these identifiers:

- `p24-blik` - BLIK payments service
- `p24-cards` - Card payments service
- `p24-provider` - General P24 payments service

### Provider IDs in Configuration

When configuring in `medusa-config.ts`, use these IDs:

- `p24-blik` - For BLIK payments
- `p24-cards` - For card payments
- `p24-general` - For general P24 payments

### Final Provider IDs

Medusa creates the final provider IDs as: `pp_{service_identifier}_{config_id}`

- BLIK: `pp_p24-blik_p24-blik`
- Cards: `pp_p24-cards_p24-cards`
- General: `pp_p24-provider_p24-general`

### Payment Methods

- **BLIK**: Channel 64, Method 181
- **Cards**: Channel 1
- **General**: Channel 0 (all methods)

## Security

- All webhook payloads are verified using SHA384 signatures
- Signature format: `{"sessionId":"str","merchantId":int,"amount":int,"currency":"str","crc":"str"}`
- CRC key is used for signature generation and verification
- P24 API uses Basic authentication (pos_id:api_key)
- Sandbox mode available for testing

## Error Handling

The plugin includes comprehensive error handling:

- API connection errors with retry logic
- Invalid payment data validation
- Webhook signature verification
- Transaction verification

## Development

### Building

```bash
npm run build
```

### Testing

```bash
npm run test
```

## Support

For issues and questions:

1. Check P24 API documentation
2. Verify webhook configuration
3. Check environment variables
4. Review Medusa logs

## License

MIT License

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request
