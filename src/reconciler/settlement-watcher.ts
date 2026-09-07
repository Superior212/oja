/**
 * Settlement reconciliation.
 *
 * Moove does not expose webhooks yet, so settlement is discovered by polling
 * the list endpoint. This is the least glamorous file in the repo and the one
 * most likely to decide whether merchants trust the product, because a merchant
 * who ships before funds land loses money, and a merchant who waits too long
 * loses the customer.
 *
 * The whole surface is one interface, `SettlementSource`. The poller below is
 * one implementation. When webhooks ship, a second implementation drops in and
 * nothing else in the codebase changes. That is the reason for the indirection.
 */

import type { MooveClient } from "../moove/client.ts";
import type { PaymentLink } from "../moove/types.ts";
import type { Order, OrderStore } from "../orders/types.ts";

export interface SettlementEvent {
  orderId: string;
  paymentLinkId: string;
  receivedAmount: string;
  transactionUrl: string | null;
}

export interface SettlementSource {
  start(): void;
  stop(): void;
}

export interface PollingWatcherOptions {
  client: MooveClient;
  store: OrderStore;
  onSettled: (event: SettlementEvent) => Promise<void>;
  /** Base interval between sweeps, in ms. Default 10s. */
  intervalMs?: number;
  /** Stop watching an order after this long. Default 60 minutes. */
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  logger?: Pick<Console, "warn" | "info">;
}

export class PollingSettlementWatcher implements SettlementSource {
  readonly #client: MooveClient;
  readonly #store: OrderStore;
  readonly #onSettled: (event: SettlementEvent) => Promise<void>;
  readonly #intervalMs: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #logger: Pick<Console, "warn" | "info">;
  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(options: PollingWatcherOptions) {
    this.#client = options.client;
    this.#store = options.store;
    this.#onSettled = options.onSettled;
    this.#intervalMs = options.intervalMs ?? 10_000;
    this.#ttlMs = options.ttlMs ?? 60 * 60 * 1000;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger ?? console;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.sweep(), this.#intervalMs);
    // Do not hold the process open purely for the poller.
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * One reconciliation pass.
   *
   * Pages the completed links once and matches them against every open order,
   * rather than making one API call per open order. With 10 results per page
   * and a rate limit per key, per-order polling would not survive even a modest
   * merchant count. This is O(pages), not O(open orders).
   *
   * Exposed for tests and for a manual `npm run link:watch`.
   */
  async sweep(): Promise<number> {
    if (this.#running) return 0; // never let sweeps overlap
    this.#running = true;
    try {
      const open = await this.#store.listAwaitingPayment();
      if (open.length === 0) return 0;

      const byLinkId = new Map<string, Order>();
      for (const order of open) {
        if (order.paymentLinkId) byLinkId.set(order.paymentLinkId, order);
      }
      if (byLinkId.size === 0) return 0;

      let settledCount = 0;
      const seen = new Set<string>();

      for await (const link of this.#client.iteratePaymentLinks({ status: "completed" })) {
        seen.add(link.id);
        const order = byLinkId.get(link.id);
        if (!order || !isSettled(link)) continue;

        await this.#store.update(order.id, {
          status: "settled",
          ...(link.transactionUrl ? { transactionUrl: link.transactionUrl } : {}),
        });
        await this.#onSettled({
          orderId: order.id,
          paymentLinkId: link.id,
          receivedAmount: link.receivedAmount ?? link.toAmount,
          transactionUrl: link.transactionUrl,
        });
        settledCount++;
        byLinkId.delete(link.id);
        if (byLinkId.size === 0) break; // nothing left to look for, stop paging
      }

      await this.#expireStale(byLinkId);
      return settledCount;
    } catch (error) {
      // A failed sweep must never kill the loop. The next tick retries, and the
      // client already backs off on 429 and 5xx.
      this.#logger.warn(
        `[reconciler] sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    } finally {
      this.#running = false;
    }
  }

  async #expireStale(stillOpen: Map<string, Order>): Promise<void> {
    const cutoff = this.#now() - this.#ttlMs;
    for (const order of stillOpen.values()) {
      if (Date.parse(order.createdAt) < cutoff) {
        await this.#store.update(order.id, { status: "expired" });
        this.#logger.info(`[reconciler] order ${order.id} expired without settlement`);
      }
    }
  }
}

/**
 * A link counts as settled when the API says completed and something arrived.
 *
 * Both conditions matter. Status alone is the API's view of the lifecycle;
 * receivedAmount is the money. Requiring both means a status change without a
 * corresponding receipt never tells a merchant to ship goods.
 */
export function isSettled(link: PaymentLink): boolean {
  if (link.status !== "completed") return false;
  const received = link.receivedAmount;
  if (received === null || received === undefined) return false;
  return Number(received) > 0;
}
