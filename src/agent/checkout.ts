/**
 * Turning an agreed price into a Moove payment link.
 *
 * This is the moment the whole product exists for: a number the agent arrived
 * at through conversation becomes a real, payable request, inside the chat.
 */

import type { MooveClient } from "../moove/client.ts";
import { formatAmount } from "../moove/money.ts";
import type { Order, OrderStore } from "../orders/types.ts";

export interface CheckoutOptions {
  client: MooveClient;
  store: OrderStore;
  settlementTokenDecimals: number;
  /**
   * How long the buyer has to pay before the link expires.
   *
   * This is price risk management, not tidiness. The merchant quoted in naira
   * and the link is denominated in the settlement token, so a long-lived link
   * is an open option written against the exchange rate. Fifteen minutes is
   * long enough to pay and short enough that nobody is arbitraging the shop.
   */
  expiryMinutes?: number;
  now?: () => Date;
}

export interface CheckoutResult {
  order: Order;
  paymentUrl: string;
  paymentLinkId: string;
  displayAmount: string;
}

export async function createCheckout(
  order: Order,
  agreedPriceMinor: bigint,
  options: CheckoutOptions,
): Promise<CheckoutResult> {
  if (order.status === "settled") throw new Error(`Order ${order.id} is already settled`);
  if (agreedPriceMinor < order.policy.floorPriceMinor) {
    // Belt and braces. evaluateOffer already guarantees this, but a payment
    // link is irreversible enough to be worth checking twice.
    throw new Error(
      `Refusing to create a link below the merchant floor for order ${order.id}`,
    );
  }

  const now = options.now?.() ?? new Date();
  const expiryMinutes = options.expiryMinutes ?? 15;
  const expirationDate = new Date(now.getTime() + expiryMinutes * 60_000).toISOString();
  const displayAmount = formatAmount(agreedPriceMinor, options.settlementTokenDecimals);

  const created = await options.client.createPaymentLink({
    toAmount: displayAmount,
    description: truncate(`${order.itemName} for ${order.buyerWaId} (order ${order.id})`, 500),
    maxUsage: 1, // one order, one link, so reconciliation is unambiguous
    expirationDate,
  });

  const updated = await options.store.update(order.id, {
    status: "awaiting_payment",
    agreedPriceMinor,
    paymentLinkId: created.id,
    paymentLinkUrl: created.url,
  });

  return {
    order: updated,
    paymentUrl: created.url,
    paymentLinkId: created.id,
    displayAmount,
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
