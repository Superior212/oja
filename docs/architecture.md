# Architecture

## The transaction

```
1. Buyer messages the merchant's WhatsApp Business number
2. Agent works the catalogue, answers questions
3. Buyer makes an offer
4. Negotiation engine decides: accept, counter, or hold
5. On accept, checkout creates a Moove payment link for exactly that amount
6. Link goes into the chat, expires in 15 minutes
7. Buyer pays in any supported asset on any supported chain
8. Reconciler detects settlement, captures the transaction URL
9. Agent confirms in chat, merchant fulfils
10. Merchant off-ramps to naira through Moove Ramp when they choose
```

## Trust boundaries

There are three, and they are the reason the code is shaped the way it is.

**Buyer text is hostile input.** Anything arriving over WhatsApp is untrusted. It reaches a model, which means it can attempt prompt injection. The mitigation is not better prompt wording, it is that the model holds no authority worth stealing: it cannot set a price, cannot create a link for an arbitrary amount, and cannot confirm a payment. Those live behind `evaluateOffer`, `createCheckout` and `isSettled`.

**The model is a conversational surface, not a decision maker.** It chooses words. The engine chooses numbers. When the engine says hold, there is no code path by which the model can produce a lower price, because it never produces prices at all.

**Merchant keys are the crown jewels, and are deliberately not very valuable.** Each merchant's Moove key is stored encrypted per tenant. Even in full compromise, a key can only create payment requests that pay its own owner, because the Moove API does not let the caller name a destination. Oja never custodies funds and never touches a wallet.

## Why polling, and why it is isolated

Moove has not shipped webhooks. Settlement is therefore discovered by polling `GET /v1/payment-link`.

The naive implementation polls once per open order. With ten results per page and a per-key rate limit, that stops working somewhere around a handful of concurrent merchants. So `sweep()` inverts it: page the completed links once, build a map of open orders by payment link id, and match. One pass reconciles every open order at once, and it stops paging as soon as the map is empty.

Sweeps never overlap, a failed sweep never kills the loop, and orders that outlive their TTL are marked expired rather than polled forever.

All of it sits behind the `SettlementSource` interface. Swapping to webhooks is a new implementation of that interface and no change anywhere else. This is the single piece of the codebase most likely to be thrown away, which is exactly why it is behind a seam.

## The concession curve

Each round concedes a shrinking slice of the remaining gap between the current quote and the floor:

```
concession_n = remaining_gap × firstConcessionBps × (concessionDecayBps / 10000)^n
```

With a 30% first concession and 50% decay, the agent gives away 30% of the gap, then 15%, then 7.5%. The price approaches the floor asymptotically and is hard-clamped to it, which reproduces how a real trader signals they are near their limit without ever crossing it.

Three special cases matter commercially:

- An offer above the quote is accepted **at the quote**, not at the offer. Charging a buyer more than the agreed price because they typed a bigger number is how you lose them permanently.
- An at-or-above-floor offer is accepted once concessions run out. Losing a sale at the floor to protect a principle is just losing a sale.
- A counter that would land below the buyer's own offer is never sent. The engine takes the offer instead.

## Data model

`Order` is the unit of work. It carries the negotiation policy, the running negotiation state, the agreed price once there is one, and the Moove payment link id.

One order maps to exactly one payment link, enforced with `maxUsage: 1`. That makes reconciliation unambiguous: a completed link identifies precisely one order.

`OrderStore` is an interface. `MemoryOrderStore` runs the whole flow locally and in tests. Postgres slots in behind the same five methods.

## What is not built yet

The conversation loop. `src/agent/tools.ts` defines the tool surface and system prompt, and `src/server.ts` has the handler stub where the model call goes. Everything the model would call already exists and is tested.

This ordering was deliberate. The money paths, the floor invariant, and the settlement logic are the parts that cost real money when wrong, and they are the parts a grant reviewer can verify without running anything.
