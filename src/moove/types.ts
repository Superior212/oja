/**
 * Types mirroring the Moove Payments API.
 *
 * Source of truth: https://api.moove.xyz/openapi.json (OpenAPI 3.1.0)
 * Rendered:        https://api.moove.xyz/docs
 * Guide:           https://docs.moove.xyz/api-reference/moove-receive/moove-payment-links
 */

/** Lifecycle of a payment link as reported by the API. */
export type PaymentLinkStatus = "active" | "inactive" | "completed";

/** Body of POST /v1/payment-link. */
export interface CreatePaymentLinkInput {
  /**
   * Amount to request, denominated in the settlement token.
   * Precision must match the settlement token's decimals (USDC is 6).
   * Passed as a string to avoid float drift on the wire.
   */
  toAmount: string;
  /** Shown to the payer on the hosted checkout. Max 500 characters. */
  description?: string;
  /** 1 to 2147483647. Unlimited if omitted. Oja always sets 1: one order, one link. */
  maxUsage?: number;
  /** ISO 8601, must be in the future. Never expires if omitted. */
  expirationDate?: string;
}

/** Response of POST /v1/payment-link. */
export interface PaymentLinkCreation {
  id: string;
  url: string;
}

/** A payment link as returned by the list endpoint. */
export interface PaymentLink {
  id: string;
  userId: string;
  toAmount: string;
  /** Settlement destination. Always the key owner's default wallet, never caller-specified. */
  destinationAddress: string;
  url: string;
  dateCreated: string;
  /** Settlement token symbol, e.g. "USDC". */
  token: string;
  status: PaymentLinkStatus;
  description: string | null;
  maxUsage: number | null;
  /** Amount actually received so far. This is what settlement is judged on. */
  receivedAmount: string | null;
  expirationDate: string | null;
  /** Block explorer URL for the settling transaction. Milestone evidence lives here. */
  transactionUrl: string | null;
}

/** Query parameters of GET /v1/payment-link. */
export interface ListPaymentLinksInput {
  status?: PaymentLinkStatus;
  /** Zero-based. The API returns 10 per page. */
  offset?: number;
}

/** Response of GET /v1/payment-link. */
export interface PaginatedPaymentLinks {
  data: PaymentLink[];
  limit: number;
  offset: number;
  /** Null when there is no further page. */
  nextOffset: number | null;
}

/** Shape of every Moove error body: { errors: [{ message, code }] }. */
export interface MooveApiErrorBody {
  errors: Array<{ message: string; code?: string }>;
}
