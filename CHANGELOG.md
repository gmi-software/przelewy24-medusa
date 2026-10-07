# Changelog

## 0.1.5

### Changed
- Non-2xx Przelewy24 API responses now throw a typed `P24ApiError` (`status`, `method`, `endpoint`, `p24Code`, `p24Description`, `responseBody`, `localizedMessage`). The message keeps the `P24 API request failed: <status> <statusText>` prefix and appends P24 error details, e.g. `P24 API request failed: 400 Bad Request - 400: Incorrect blikCode`. Response bodies are parsed as JSON or truncated to 1000 characters, with API key, CRC, Authorization, `token` and `sign` values masked
- Failed BLIK charges log `[p24-charge] <message> context={...}` with payment session id, P24 session id, cart id, amount, endpoint, HTTP status and P24 code/description, and store `error_http_status`, `error_p24_code`, `error_p24_description`, `error_endpoint`, `error_session_id`, `error_amount_grosze` next to `error_message` on the payment session
- Card charge failures are now logged with the same context (`[p24-card-charge]`)
- `P24ApiError.message` (and therefore `error_message` on the session) is always the technical message, even for known P24 codes; the localized customer text is available as `P24ApiError.localizedMessage` and is still what `POST /store/payments/blik/charge` and `POST /store/payments/card/charge` return in `message`. For unknown P24 codes those routes and `POST /store/payments/transaction/status` return only `P24 API request failed: <status> <statusText>`; P24 error details and response text never reach the storefront. As a side effect, `isExpectedStalePaymentJobFailure` now also matches 400 responses that carry a known P24 code

## 0.1.3

### Added
- `POST /store/payments/card/tokenization-intent` — side-effect-free endpoint returning `merchant_id`, `session_id`, `card_tokenization_sign`, `amount_grosze`, `currency_code` so the storefront can render the card iframe before any payment session/collection exists (used by order-change settlement to avoid confirming an order change on method select)

### Changed
- Card tokenization session now persists `p24_session_id`, guaranteeing `POST /store/payments/card/charge` registers against the exact P24 session the widget tokenized against

## 0.1.2

### Changed
- Visa Mobile (`pp_p24-visa-mobile_przelewy24`) now uses P24 redirect with pre-selected method `198` instead of white-label charge

### Removed
- `POST /store/payments/visa-mobile/charge` endpoint and `chargeVisaMobile` API client (breaking change)

## 0.1.0

### Added
- White-label card payments via P24 hosted card iframe + `POST /store/payments/card/charge`
- Hardened BLIK route at `POST /store/payments/blik/charge` (legacy `/payments/blik` deprecated)
- Transaction status endpoint `POST /store/payments/transaction/status`
- Scheduled reconciliation job `reconcile-p24-payments`
- Configurable provider options for card channel and Visa Mobile method id
- PSU (`additional.PSU`) support for white-label registration

### Changed
- `p24-cards` is now white-label (channel `4096` by default) instead of redirect-only
- Webhook handling is verify/capture-only and never returns `AUTHORIZED`
- `updatePayment` re-registers a fresh P24 transaction when amount changes
- Replaced `console.*` logging with redacted structured logging
- Standardized persisted payment session data keys (`session_id`, `order_id`)

### Security
- P24 webhook source IP allowlist
- Card additional-notification signature verifiers (success/failure field sets)

### Documentation
- Production runbook: `Medusa/docs/P24_PAYMENTS.md`, ADR `Medusa/docs/adr/0009-p24-white-label-payments.md`
- Storefront integration: `web/docs/P24_CHECKOUT.md`
- Clarified completion model: poll `complete` for order creation; capture via webhook or `reconcile-p24-payments`
