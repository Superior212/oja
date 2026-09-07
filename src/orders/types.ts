import type { NegotiationPolicy, NegotiationState } from "../agent/negotiate.ts";

export type OrderStatus =
  | "negotiating"
  | "awaiting_payment"
  | "settled"
  | "expired"
  | "cancelled";

export interface Order {
  id: string;
  merchantId: string;
  /** Buyer's WhatsApp number, in E.164. */
  buyerWaId: string;
  itemSku: string;
  itemName: string;
  status: OrderStatus;
  policy: NegotiationPolicy;
  negotiation: NegotiationState;
  /** Set once a price is agreed. */
  agreedPriceMinor?: bigint;
  /** Moove payment link id, set when the link is created. */
  paymentLinkId?: string;
  paymentLinkUrl?: string;
  /** Block explorer URL, captured at settlement. Milestone evidence. */
  transactionUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Merchant {
  id: string;
  handle: string;
  displayName: string;
  /**
   * The merchant's own Moove API key, encrypted at rest.
   *
   * Every merchant brings their own key because payment links always settle to
   * the key owner's default wallet and the destination cannot be set by the
   * caller. A compromised Oja therefore cannot redirect funds anywhere: each
   * key can only create requests that pay its own owner.
   */
  encryptedMooveKey: string;
  settlementTokenDecimals: number;
}

export interface OrderStore {
  create(order: Order): Promise<Order>;
  get(id: string): Promise<Order | null>;
  update(id: string, patch: Partial<Order>): Promise<Order>;
  /** Orders waiting on settlement, which is exactly the reconciler's work queue. */
  listAwaitingPayment(): Promise<Order[]>;
  findByPaymentLinkId(paymentLinkId: string): Promise<Order | null>;
}
