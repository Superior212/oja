/**
 * In-memory OrderStore.
 *
 * Enough to run the whole flow end to end locally and in tests. Production
 * swaps in Postgres behind the same interface; nothing above this layer knows
 * or cares which one is mounted.
 */

import type { Order, OrderStore } from "./types.ts";

export class MemoryOrderStore implements OrderStore {
  readonly #orders = new Map<string, Order>();

  async create(order: Order): Promise<Order> {
    if (this.#orders.has(order.id)) throw new Error(`Duplicate order id: ${order.id}`);
    this.#orders.set(order.id, { ...order });
    return { ...order };
  }

  async get(id: string): Promise<Order | null> {
    const found = this.#orders.get(id);
    return found ? { ...found } : null;
  }

  async update(id: string, patch: Partial<Order>): Promise<Order> {
    const existing = this.#orders.get(id);
    if (!existing) throw new Error(`No such order: ${id}`);
    const next: Order = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.#orders.set(id, next);
    return { ...next };
  }

  async listAwaitingPayment(): Promise<Order[]> {
    return [...this.#orders.values()]
      .filter((o) => o.status === "awaiting_payment")
      .map((o) => ({ ...o }));
  }

  async findByPaymentLinkId(paymentLinkId: string): Promise<Order | null> {
    for (const order of this.#orders.values()) {
      if (order.paymentLinkId === paymentLinkId) return { ...order };
    }
    return null;
  }
}
