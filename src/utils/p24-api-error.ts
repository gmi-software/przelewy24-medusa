import { buildLocalizedP24ErrorMessage, extractP24ErrorCode } from "./p24-errors";
import { redactUnknown } from "./p24-logger";

export const P24_ERROR_BODY_MAX_LENGTH = 1000;

const REDACTED = "[REDACTED]";

const SECRET_KEYS = new Set(["sign", "crc"]);

/** Any key containing one of these (after dropping `_`/`-`) is masked, e.g. `access_token`, `cardToken`. */
const SECRET_KEY_FRAGMENTS = [
  "token",
  "secret",
  "password",
  "apikey",
  "authorization",
  "credential",
];

const SECRET_TEXT_PATTERNS: RegExp[] = [
  /\b(Basic|Bearer)\s+[A-Za-z0-9+/=._-]+/gi,
  /("(?:[\w-]*(?:token|secret|password|api_?key|authorization|credential)[\w-]*|sign|crc)"\s*:\s*")[^"]*(")/gi,
  /\b((?:[\w-]*(?:token|secret|password|api_?key|credential)[\w-]*|sign|crc)\s*[=:]\s*)[^\s&,;"']+/gi,
];

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return (
    SECRET_KEYS.has(normalized) ||
    SECRET_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment))
  );
}

export type P24ApiErrorInit = {
  status: number;
  statusText: string;
  method: string;
  endpoint: string;
  responseText: string;
  secrets?: Array<string | undefined>;
};

/**
 * Error thrown for non-2xx Przelewy24 API responses. `message` always starts
 * with `P24 API request failed: <status> <statusText>`; stale-job detection
 * in `payment-job-errors.ts` relies on that prefix.
 */
export class P24ApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly method: string;
  /** Request path without query string. */
  readonly endpoint: string;
  readonly p24Code?: string | number;
  readonly p24Description?: string;
  /** Masked response body: parsed JSON or truncated text. */
  readonly responseBody?: unknown;
  readonly responseCode?: number;
  /** Customer-facing message derived from a known P24 error code or payload message. */
  readonly localizedMessage?: string;

  /** @deprecated Use `responseBody`. */
  get payload(): unknown {
    return this.responseBody;
  }

  constructor(init: P24ApiErrorInit) {
    const secrets = init.secrets ?? [];
    const responseBody = parseMaskedBody(init.responseText, secrets);
    const { code, description } = extractP24ErrorDetails(responseBody);
    const prefix = formatP24ApiErrorPrefix(init.status, init.statusText);
    const detail = formatDetail(code, description);

    super(detail ? `${prefix} - ${detail}` : prefix);

    this.name = "P24ApiError";
    this.status = init.status;
    this.statusText = init.statusText;
    this.method = init.method;
    this.endpoint = stripQuery(init.endpoint);
    this.p24Code = code;
    this.p24Description = description;
    this.responseBody = responseBody;

    if (responseBody && typeof responseBody === "object") {
      const responseCode = (responseBody as Record<string, unknown>).responseCode;
      this.responseCode = typeof responseCode === "number" ? responseCode : undefined;

      const localized = buildLocalizedP24ErrorMessage(responseBody, "");
      this.localizedMessage = localized || undefined;
    }
  }
}

export type P24FailureDetails = {
  message: string;
  http_status?: number;
  endpoint?: string;
  p24_code?: string | number;
  p24_description?: string;
};

export function getP24FailureDetails(error: unknown): P24FailureDetails {
  if (error instanceof P24ApiError) {
    return {
      message: error.message,
      http_status: error.status,
      endpoint: error.endpoint,
      p24_code: error.p24Code,
      p24_description: error.p24Description,
    };
  }

  return {
    message: error instanceof Error ? error.message : "Unknown payment charge error",
  };
}

/**
 * Message safe to return to the storefront: localized for known P24 codes,
 * otherwise only the status line. Upstream response text stays in logs and
 * session data because masking cannot catch every secret format.
 */
export function getP24UserFacingMessage(error: unknown, fallback: string): string {
  if (error instanceof P24ApiError) {
    return (
      error.localizedMessage ?? formatP24ApiErrorPrefix(error.status, error.statusText)
    );
  }

  return error instanceof Error ? error.message : fallback;
}

export function maskSecretsInText(
  text: string,
  secrets: Array<string | undefined> = [],
): string {
  let masked = text;

  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) {
      masked = masked.split(secret).join(REDACTED);
    }
  }

  for (const pattern of SECRET_TEXT_PATTERNS) {
    masked = masked.replace(pattern, (match, ...groups: unknown[]) => {
      const [first, second] = groups;
      if (typeof first !== "string") {
        return REDACTED;
      }
      if (/^(basic|bearer)$/i.test(first)) {
        return `${first} ${REDACTED}`;
      }
      return `${first}${REDACTED}${typeof second === "string" ? second : ""}`;
    });
  }

  return masked;
}

export function maskSecretsInValue(
  value: unknown,
  secrets: Array<string | undefined> = [],
): unknown {
  if (typeof value === "string") {
    return maskSecretsInText(value, secrets);
  }

  if (Array.isArray(value)) {
    return value.map((item) => maskSecretsInValue(item, secrets));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const output: Record<string, unknown> = {};

  for (const [key, nested] of Object.entries(value)) {
    output[key] = isSecretKey(key)
      ? REDACTED
      : maskSecretsInValue(nested, secrets);
  }

  return redactUnknown(output);
}

function truncate(text: string, maxLength = P24_ERROR_BODY_MAX_LENGTH): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…[truncated]` : text;
}

function parseMaskedBody(
  responseText: string,
  secrets: Array<string | undefined>,
): unknown {
  const trimmed = responseText.trim();

  if (!trimmed) {
    return undefined;
  }

  try {
    return maskSecretsInValue(JSON.parse(trimmed), secrets);
  } catch {
    return truncate(maskSecretsInText(trimmed, secrets));
  }
}

function describeValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }

  if (value && typeof value === "object") {
    return JSON.stringify(value);
  }

  return undefined;
}

function extractP24ErrorDetails(body: unknown): {
  code?: string | number;
  description?: string;
} {
  if (typeof body === "string") {
    return { description: body };
  }

  if (!body || typeof body !== "object") {
    return {};
  }

  const record = body as Record<string, unknown>;
  const data =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : {};

  const rawCode =
    extractP24ErrorCode(body) ??
    [record.code, record.errorCode, data.code, data.errorCode].find(
      (value) => typeof value === "number" || typeof value === "string",
    );

  const description =
    describeValue(record.error) ??
    describeValue(record.message) ??
    describeValue(data.message) ??
    describeValue(data.error) ??
    describeValue(record.errorMessage) ??
    describeValue(record.description);

  return {
    code: rawCode as string | number | undefined,
    description: description ? truncate(description) : undefined,
  };
}

function formatDetail(
  code: string | number | undefined,
  description: string | undefined,
): string | undefined {
  if (code != null && description) {
    return `${code}: ${description}`;
  }

  return description ?? (code != null ? String(code) : undefined);
}

function formatP24ApiErrorPrefix(status: number, statusText: string): string {
  return `P24 API request failed: ${status} ${statusText}`;
}

function stripQuery(endpoint: string): string {
  const index = endpoint.indexOf("?");
  return index === -1 ? endpoint : endpoint.slice(0, index);
}
