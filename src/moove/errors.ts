/**
 * Typed errors for the Moove API.
 *
 * The status codes below are the documented ones. Each maps to an operator
 * action, which is why they are distinct classes rather than one blob:
 * a 403 means fix your key's scopes, a 409 means finish account setup, and
 * a 429 means back off. Those are three different pages of a runbook.
 */

export class MooveError extends Error {
  override readonly name: string = "MooveError";
}

export class MooveApiError extends MooveError {
  override readonly name: string = "MooveApiError";
  readonly status: number;
  readonly code: string | undefined;
  readonly messages: string[];

  constructor(status: number, messages: string[], code?: string) {
    super(`Moove API ${status}: ${messages.join("; ") || "no message"}`);
    this.status = status;
    this.messages = messages;
    this.code = code;
  }

  /** True when a retry could plausibly succeed without operator action. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/** 401. Key missing, invalid, or expired. */
export class MooveAuthError extends MooveApiError {
  override readonly name: string = "MooveAuthError";
}

/** 403. Key is valid but lacks the scope for this call. */
export class MooveScopeError extends MooveApiError {
  override readonly name: string = "MooveScopeError";
}

/** 409. Account is not set up to receive payments yet. */
export class MooveAccountNotReadyError extends MooveApiError {
  override readonly name: string = "MooveAccountNotReadyError";
}

/** 422. Request failed validation. Usually amount precision or a bad expiry. */
export class MooveValidationError extends MooveApiError {
  override readonly name: string = "MooveValidationError";
}

/** 429. Rate limited, per key and per IP. */
export class MooveRateLimitError extends MooveApiError {
  override readonly name: string = "MooveRateLimitError";
  /** Seconds to wait, when the response carried Retry-After. */
  readonly retryAfterSeconds: number | undefined;

  constructor(status: number, messages: string[], retryAfterSeconds?: number, code?: string) {
    super(status, messages, code);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Network failure or timeout. Never reached the API. */
export class MooveTransportError extends MooveError {
  override readonly name: string = "MooveTransportError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export function errorForStatus(
  status: number,
  messages: string[],
  opts: { retryAfterSeconds?: number; code?: string } = {},
): MooveApiError {
  switch (status) {
    case 401:
      return new MooveAuthError(status, messages, opts.code);
    case 403:
      return new MooveScopeError(status, messages, opts.code);
    case 409:
      return new MooveAccountNotReadyError(status, messages, opts.code);
    case 422:
      return new MooveValidationError(status, messages, opts.code);
    case 429:
      return new MooveRateLimitError(status, messages, opts.retryAfterSeconds, opts.code);
    default:
      return new MooveApiError(status, messages, opts.code);
  }
}
