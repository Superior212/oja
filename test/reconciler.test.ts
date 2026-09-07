import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MooveClient } from "../src/moove/client.ts";
import { MemoryOrderStore } from "../src/orders/memory-store.ts";
import { PollingSettlementWatcher, isSettled } from "../src/reconciler/settlement-watcher.ts";
import type { PaymentLink } from "../src/moove/types.ts";
import type { Order } from "../src/orders/types.ts";

const silent = { warn: () => {}, info: () => {} };

function link(overrides: Partial<PaymentLink> = {}): PaymentLink {
  return {
    id: "pl_1",
    userId: "u_1",
    toAmount: "10",
    destinationAddress: "0xmerchant",
    url: "https://moove.xyz/pay/pl_1",
    dateCreated: new Date().toISOString(),
    token: "USDC",
    status: "completed",
    description: null,
    maxUsage: 1,
    receivedAmount: "10",
    expirationDate: null,
    transactionUrl: "https://explorer/tx/0xabc",
    ...overrides,
  };
}

function order(overrides: Partial<Order> = {}): Order {
  const now = new Date().toISOString();
  return {
    id: "ord_1",
    merchantId: "m_1",
    buyerWaId: "2348000000000",
    itemSku: "sku-1",
    itemName: "Ankara two-piece",
    status: "awaiting_payment",
    policy: {
      listPriceMinor: 20_000_000n,
      floorPriceMinor: 14_000_000n,
      maxConcessions: 2,
      firstConcessionBps: 3000,
      concessionDecayBps: 5000,
    },
    negotiation: { concessionsMade: 0, lastQuotedMinor: 20_000_000n },
    paymentLinkId: "pl_1",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function clientReturning(pages: PaymentLink[][]) {
  let i = 0;
  const fetchImpl = (async () => {
    const page = pages[Math.min(i, pages.length - 1)] ?? [];
    const nextOffset = i < pages.length - 1 ? (i + 1) * 10 : null;
    i++;
    return new Response(JSON.stringify({ data: page, limit: 10, offset: 0, nextOffset }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return new MooveClient({ apiKey: "k", fetch: fetchImpl, sleep: async () => {} });
}

describe("isSettled", () => {
  test("requires both completed status and a received amount", () => {
    assert.equal(isSettled(link()), true);
    assert.equal(isSettled(link({ status: "active" })), false);
    assert.equal(isSettled(link({ receivedAmount: null })), false);
    assert.equal(isSettled(link({ receivedAmount: "0" })), false);
  });
});

describe("PollingSettlementWatcher", () => {
  test("settles a matching order and records the transaction url", async () => {
    const store = new MemoryOrderStore();
    await store.create(order());

    const settled: string[] = [];
    const watcher = new PollingSettlementWatcher({
      client: clientReturning([[link()]]),
      store,
      logger: silent,
      onSettled: async (event) => {
        settled.push(event.orderId);
      },
    });

    const count = await watcher.sweep();

    assert.equal(count, 1);
    assert.deepEqual(settled, ["ord_1"]);
    const after = await store.get("ord_1");
    assert.equal(after?.status, "settled");
    assert.equal(after?.transactionUrl, "https://explorer/tx/0xabc");
  });

  test("ignores links that belong to no open order", async () => {
    const store = new MemoryOrderStore();
    await store.create(order({ paymentLinkId: "pl_other" }));

    const watcher = new PollingSettlementWatcher({
      client: clientReturning([[link({ id: "pl_1" })]]),
      store,
      logger: silent,
      onSettled: async () => assert.fail("should not have settled anything"),
    });

    assert.equal(await watcher.sweep(), 0);
  });

  test("does nothing when there are no open orders, without calling the API", async () => {
    const store = new MemoryOrderStore();
    await store.create(order({ status: "settled" }));

    const watcher = new PollingSettlementWatcher({
      client: clientReturning([[link()]]),
      store,
      logger: silent,
      onSettled: async () => assert.fail("no open orders to settle"),
    });

    assert.equal(await watcher.sweep(), 0);
  });

  test("expires an order that outlives its ttl", async () => {
    const store = new MemoryOrderStore();
    const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    await store.create(order({ createdAt: old }));

    const watcher = new PollingSettlementWatcher({
      client: clientReturning([[]]),
      store,
      logger: silent,
      ttlMs: 60 * 60_000,
      onSettled: async () => assert.fail("nothing settled"),
    });

    await watcher.sweep();
    assert.equal((await store.get("ord_1"))?.status, "expired");
  });

  test("a failing API call does not throw out of the sweep", async () => {
    const store = new MemoryOrderStore();
    await store.create(order());

    const exploding = new MooveClient({
      apiKey: "k",
      sleep: async () => {},
      maxRetries: 0,
      fetch: (async () => {
        throw new Error("network down");
      }) as unknown as typeof globalThis.fetch,
    });

    const watcher = new PollingSettlementWatcher({
      client: exploding,
      store,
      logger: silent,
      onSettled: async () => assert.fail("nothing settled"),
    });

    assert.equal(await watcher.sweep(), 0, "should swallow and let the next tick retry");
    assert.equal((await store.get("ord_1"))?.status, "awaiting_payment");
  });
});
