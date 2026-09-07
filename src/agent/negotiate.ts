/**
 * The negotiation engine.
 *
 * This is the part that makes Oja agentic rather than a checkout button. In this
 * market a fixed price is a lost sale, so the agent has to arrive at a number
 * with the buyer and then settle exactly that number.
 *
 * The single most important property here: THE FLOOR IS ENFORCED IN CODE, NOT
 * IN THE PROMPT. The model proposes, this module disposes. A buyer who tells the
 * agent to ignore its instructions, or a prompt injection buried in a product
 * question, cannot move the price below the merchant's floor, because the model
 * never gets to decide the number. It only gets to decide whether to keep talking.
 *
 * All arithmetic is in bigint minor units. No floats touch a price.
 */

import { applyBps } from "../moove/money.ts";

export interface NegotiationPolicy {
  /** Opening price, in settlement token minor units. */
  listPriceMinor: bigint;
  /** Hard floor. The agent will never settle below this. */
  floorPriceMinor: bigint;
  /**
   * How many counters the agent will make before it stops conceding.
   * Real traders do not concede forever, and neither should this.
   */
  maxConcessions: number;
  /**
   * Fraction of the remaining gap to give away on the first concession,
   * in basis points. 3000 means the first counter gives up 30% of the
   * distance from list to floor. Later concessions shrink, which is how
   * a human signals they are near their limit.
   */
  firstConcessionBps: number;
  /** Multiplier applied to each subsequent concession, in bps. 5000 halves it each round. */
  concessionDecayBps: number;
  /**
   * If the buyer offers at or above this, accept immediately rather than
   * countering. Prevents the agent haggling away a good offer.
   */
  instantAcceptMinor?: bigint;
}

export interface NegotiationState {
  /** Counters the agent has already made. */
  concessionsMade: number;
  /** The last price the agent put on the table. */
  lastQuotedMinor: bigint;
}

export type NegotiationDecision =
  | { kind: "accept"; priceMinor: bigint; reason: string }
  | { kind: "counter"; priceMinor: bigint; state: NegotiationState; reason: string }
  | { kind: "hold"; priceMinor: bigint; reason: string };

export class PolicyError extends Error {
  override readonly name = "PolicyError";
}

export function validatePolicy(policy: NegotiationPolicy): void {
  if (policy.listPriceMinor <= 0n) throw new PolicyError("listPrice must be positive");
  if (policy.floorPriceMinor <= 0n) throw new PolicyError("floorPrice must be positive");
  if (policy.floorPriceMinor > policy.listPriceMinor) {
    throw new PolicyError("floorPrice cannot exceed listPrice");
  }
  if (!Number.isInteger(policy.maxConcessions) || policy.maxConcessions < 0) {
    throw new PolicyError("maxConcessions must be a non-negative integer");
  }
  if (policy.firstConcessionBps < 0 || policy.firstConcessionBps > 10_000) {
    throw new PolicyError("firstConcessionBps must be between 0 and 10000");
  }
  if (policy.concessionDecayBps < 0 || policy.concessionDecayBps > 10_000) {
    throw new PolicyError("concessionDecayBps must be between 0 and 10000");
  }
}

export function openingState(policy: NegotiationPolicy): NegotiationState {
  validatePolicy(policy);
  return { concessionsMade: 0, lastQuotedMinor: policy.listPriceMinor };
}

/**
 * Decide what to do with a buyer's offer.
 *
 * Returns one of:
 *   accept  - close at this price, create the payment link
 *   counter - put a new number on the table, keep talking
 *   hold    - repeat the current number, no more concessions left
 *
 * The returned price is ALWAYS >= floorPriceMinor. That is the invariant the
 * test suite asserts against thousands of random offers, including hostile ones.
 */
export function evaluateOffer(
  policy: NegotiationPolicy,
  state: NegotiationState,
  buyerOfferMinor: bigint,
): NegotiationDecision {
  validatePolicy(policy);

  if (buyerOfferMinor < 0n) {
    return { kind: "hold", priceMinor: state.lastQuotedMinor, reason: "negative offer ignored" };
  }

  // Buyer met or beat the number on the table. Close it.
  if (buyerOfferMinor >= state.lastQuotedMinor) {
    return {
      kind: "accept",
      priceMinor: state.lastQuotedMinor,
      reason: "buyer met the quoted price",
    };
  }

  // Buyer cleared the merchant's instant-accept threshold.
  if (policy.instantAcceptMinor !== undefined && buyerOfferMinor >= policy.instantAcceptMinor) {
    return { kind: "accept", priceMinor: buyerOfferMinor, reason: "offer cleared instant-accept" };
  }

  // Buyer offered at or above the floor. Taking it beats losing the sale.
  if (buyerOfferMinor >= policy.floorPriceMinor && state.concessionsMade >= policy.maxConcessions) {
    return { kind: "accept", priceMinor: buyerOfferMinor, reason: "at floor, no concessions left" };
  }

  // Out of concessions and the offer is below floor. Hold the line.
  if (state.concessionsMade >= policy.maxConcessions) {
    return {
      kind: "hold",
      priceMinor: maxBigint(state.lastQuotedMinor, policy.floorPriceMinor),
      reason: "no concessions left and offer is below floor",
    };
  }

  const counter = nextCounter(policy, state);

  // If conceding would land at or below the buyer's offer, just take the offer,
  // as long as it clears the floor. Never counter below what is already on the table.
  if (counter <= buyerOfferMinor && buyerOfferMinor >= policy.floorPriceMinor) {
    return { kind: "accept", priceMinor: buyerOfferMinor, reason: "counter would undercut offer" };
  }

  return {
    kind: "counter",
    priceMinor: counter,
    state: { concessionsMade: state.concessionsMade + 1, lastQuotedMinor: counter },
    reason: `concession ${state.concessionsMade + 1} of ${policy.maxConcessions}`,
  };
}

/**
 * The concession curve.
 *
 * Each round gives away a shrinking slice of the remaining gap to the floor,
 * so the price approaches the floor without ever reaching or crossing it until
 * the merchant's concession budget is spent. Clamped to the floor regardless.
 */
function nextCounter(policy: NegotiationPolicy, state: NegotiationState): bigint {
  const gap = state.lastQuotedMinor - policy.floorPriceMinor;
  if (gap <= 0n) return policy.floorPriceMinor;

  let bps = policy.firstConcessionBps;
  for (let i = 0; i < state.concessionsMade; i++) {
    bps = Math.round((bps * policy.concessionDecayBps) / 10_000);
  }

  const concession = applyBps(gap, bps);
  const candidate = state.lastQuotedMinor - concession;
  return maxBigint(candidate, policy.floorPriceMinor);
}

function maxBigint(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
