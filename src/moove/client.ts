/**
 * A small typed client for the Moove Payments API.
 *
 * There is no official Moove SDK yet, so this is a thin, dependency-free
 * wrapper over plain HTTP. Node 20+ native fetch, no runtime dependencies.
 *
 * Design notes:
 *   - One client instance holds one merchant's API key. Oja is multi-tenant,
 *     and every merchant brings their own key, because payment links always
 *     settle to the key owner's default wallet and the destination cannot be
 *     set by the caller. That is a deliberate safety property of the API and
 *     the architecture is built around it rather than against it.
 *   - Retries cover 429 and 5xx only, with Retry-After honoured. A 401, 403,
 *     409 or 422 is an operator problem and retrying it just burns rate limit.
 */

import { errorForStatus, MooveApiError, MooveTransportError } from "./errors.ts";
import type {
  CreatePaymentLinkInput,
  ListPaymentLinksInput,
  MooveApiErrorBody,
  PaginatedPaymentLinks,
  PaymentLink,
  PaymentLinkCreation,
} from "./types.ts";

export const DEFAULT_BASE_URL = "https://api.moove.xyz";

export interface MooveClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Default 15000. */
  timeoutMs?: number;
  /** Retry attempts for 429 and 5xx. Default 3. */
  maxRetries?: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Injectable for tests, so retry backoff does not make the suite slow. */
  sleep?: (ms: number) => Promise<void>;
}

export class MooveClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: MooveClientOptions) {
    if (!options.apiKey) {
      throw new Error(
        "A Moove API key is required. Create one in the Moove Dashboard with the Moove Receive Agent.",
      );
    }
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * POST /v1/payment-link
   * Requires the payment_link:create scope.
   */
  async createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLinkCreation> {
    if (input.description && input.description.length > 500) {
      throw new Error("description exceeds the 500 character API limit");
    }
    if (input.maxUsage !== undefined && (input.maxUsage < 1 || !Number.isInteger(input.maxUsage))) {
      throw new Error("maxUsage must be a positive integer");
    }
    return await this.#request<PaymentLinkCreation>("POST", "/v1/payment-link", { body: input });
  }

  /**
   * GET /v1/payment-link
   * Requires the payment_link:read scope. Returns 10 per page, newest first.
   */
  async listPaymentLinks(input: ListPaymentLinksInput = {}): Promise<PaginatedPaymentLinks> {
    const query = new URLSearchParams();
    if (input.status) query.set("status", input.status);
    if (input.offset !== undefined) query.set("offset", String(input.offset));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return await this.#request<PaginatedPaymentLinks>("GET", `/v1/payment-link${suffix}`);
  }

  /**
   * Walk every page of the list endpoint.
   *
   * The reconciler needs this because there is no "fetch link by id" call on
   * the authenticated surface, so finding one link means paging until it turns
   * up. Yields links lazily so a caller can stop as soon as it has what it needs.
   */
  async *iteratePaymentLinks(
    input: Omit<ListPaymentLinksInput, "offset"> = {},
  ): AsyncGenerator<PaymentLink, void, undefined> {
    let offset = 0;
    for (;;) {
      const page = await this.listPaymentLinks({ ...input, offset });
      for (const link of page.data) yield link;
      if (page.nextOffset === null || page.data.length === 0) return;
      offset = page.nextOffset;
    }
  }

  /**
   * Find one payment link by id.
   *
   * Convenience over iteratePaymentLinks. Returns null if it is not found
   * within `maxPages`, which bounds the cost of looking for an id that has
   * aged out of the recent pages.
   */
  async findPaymentLink(
    id: string,
    opts: { status?: ListPaymentLinksInput["status"]; maxPages?: number } = {},
  ): Promise<PaymentLink | null> {
    const maxPages = opts.maxPages ?? 20;
    let offset = 0;
    for (let page = 0; page < maxPages; page++) {
      const listInput: ListPaymentLinksInput = { offset };
      if (opts.status) listInput.status = opts.status;
      const result = await this.listPaymentLinks(listInput);
      const hit = result.data.find((link) => link.id === id);
      if (hit) return hit;
      if (result.nextOffset === null || result.data.length === 0) return null;
      offset = result.nextOffset;
    }
    return null;
  }

  async #request<T>(
    method: string,
    path: string,
    opts: { body?: unknown } = {},
  ): Promise<T> {
    const url = `${this.#baseUrl}${path}`;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

      try {
        const init: RequestInit = {
          method,
          headers: {
            "X-API-Key": this.#apiKey,
            Accept: "application/json",
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          signal: controller.signal,
        };
        if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

        const response = await this.#fetch(url, init);

        if (response.ok) {
          return (await response.json()) as T;
        }

        const { messages, code } = await readErrorBody(response);
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;

        const errorOpts: { retryAfterSeconds?: number; code?: string } = {};
        if (retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)) {
          errorOpts.retryAfterSeconds = retryAfterSeconds;
        }
        if (code) errorOpts.code = code;

        const error = errorForStatus(response.status, messages, errorOpts);

        if (!error.retryable || attempt === this.#maxRetries) throw error;
        lastError = error;
        await this.#sleep(backoffMs(attempt, retryAfterSeconds));
        continue;
      } catch (cause) {
        if (cause instanceof MooveApiError) {
          if (!cause.retryable || attempt === this.#maxRetries) throw cause;
          lastError = cause;
          await this.#sleep(backoffMs(attempt));
          continue;
        }
        // Network failure, DNS, or the abort timer firing.
        const transport = new MooveTransportError(
          `${method} ${path} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
        if (attempt === this.#maxRetries) throw transport;
        lastError = transport;
        await this.#sleep(backoffMs(attempt));
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new MooveTransportError(`${method} ${path} exhausted retries`);
  }
}

async function readErrorBody(
  response: Response,
): Promise<{ messages: string[]; code: string | undefined }> {
  try {
    const body = (await response.json()) as Partial<MooveApiErrorBody>;
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      return {
        messages: body.errors.map((e) => e.message).filter(Boolean),
        code: body.errors[0]?.code,
      };
    }
  } catch {
    // Non-JSON error body. Fall through to the status text.
  }
  return { messages: [response.statusText].filter(Boolean), code: undefined };
}

/** Exponential backoff with jitter, capped at 30s. Retry-After wins when present. */
function backoffMs(attempt: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)) {
    return Math.min(retryAfterSeconds * 1000, 60_000);
  }
  const base = Math.min(2 ** attempt * 500, 30_000);
  return base + Math.floor(Math.random() * 250);
}
