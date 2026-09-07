import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateOffer,
  openingState,
  validatePolicy,
  PolicyError,
  type NegotiationPolicy,
} from "../src/agent/negotiate.ts";

const usdc = (whole: string): bigint => BigInt(whole) * 1_000_000n;

const policy: NegotiationPolicy = {
  listPriceMinor: usdc("20"),
  floorPriceMinor: usdc("14"),
  maxConcessions: 3,
  firstConcessionBps: 3000,
  concessionDecayBps: 5000,
};

describe("negotiation policy validation", () => {
  test("rejects a floor above list", () => {
    assert.throws(
      () => validatePolicy({ ...policy, floorPriceMinor: usdc("25") }),
      PolicyError,
    );
  });

  test("rejects a non-positive list price", () => {
    assert.throws(() => validatePolicy({ ...policy, listPriceMinor: 0n }), PolicyError);
  });
});

describe("evaluateOffer", () => {
  test("accepts an offer at the quoted price", () => {
    const decision = evaluateOffer(policy, openingState(policy), usdc("20"));
    assert.equal(decision.kind, "accept");
    assert.equal(decision.priceMinor, usdc("20"));
  });

  test("accepts an offer above the quoted price without pocketing more", () => {
    const decision = evaluateOffer(policy, openingState(policy), usdc("25"));
    assert.equal(decision.kind, "accept");
    assert.equal(decision.priceMinor, usdc("20"), "should charge the quote, not the overpayment");
  });

  test("counters a lowball, and the counter sits between floor and list", () => {
    const decision = evaluateOffer(policy, openingState(policy), usdc("5"));
    assert.equal(decision.kind, "counter");
    assert.ok(decision.priceMinor > policy.floorPriceMinor);
    assert.ok(decision.priceMinor < policy.listPriceMinor);
  });

  test("concessions shrink each round", () => {
    let state = openingState(policy);
    const gaps: bigint[] = [];
    for (let i = 0; i < 3; i++) {
      const decision = evaluateOffer(policy, state, usdc("1"));
      assert.equal(decision.kind, "counter");
      if (decision.kind !== "counter") return;
      gaps.push(state.lastQuotedMinor - decision.priceMinor);
      state = decision.state;
    }
    assert.ok(gaps[0]! > gaps[1]!, "second concession should be smaller than the first");
    assert.ok(gaps[1]! > gaps[2]!, "third concession should be smaller than the second");
  });

  test("holds once the concession budget is spent", () => {
    let state = openingState(policy);
    for (let i = 0; i < policy.maxConcessions; i++) {
      const decision = evaluateOffer(policy, state, usdc("1"));
      if (decision.kind !== "counter") return assert.fail("expected a counter");
      state = decision.state;
    }
    const final = evaluateOffer(policy, state, usdc("1"));
    assert.equal(final.kind, "hold");
    assert.ok(final.priceMinor >= policy.floorPriceMinor);
  });

  test("takes an at-floor offer rather than losing the sale", () => {
    let state = openingState(policy);
    for (let i = 0; i < policy.maxConcessions; i++) {
      const decision = evaluateOffer(policy, state, usdc("1"));
      if (decision.kind !== "counter") return assert.fail("expected a counter");
      state = decision.state;
    }
    const decision = evaluateOffer(policy, state, usdc("15"));
    assert.equal(decision.kind, "accept");
    assert.equal(decision.priceMinor, usdc("15"));
  });

  test("ignores a negative offer", () => {
    const decision = evaluateOffer(policy, openingState(policy), -usdc("5"));
    assert.equal(decision.kind, "hold");
  });

  /**
   * The invariant the whole design exists to protect. Ten thousand random
   * offers, including absurd and hostile ones, across randomised policies.
   * Not one may produce a price below the merchant's floor.
   */
  test("never produces a price below the floor, under fuzzing", () => {
    let checks = 0;
    for (let run = 0; run < 400; run++) {
      const floor = BigInt(1 + Math.floor(Math.random() * 500)) * 1_000_000n;
      const list = floor + BigInt(1 + Math.floor(Math.random() * 500)) * 1_000_000n;
      const fuzzPolicy: NegotiationPolicy = {
        listPriceMinor: list,
        floorPriceMinor: floor,
        maxConcessions: Math.floor(Math.random() * 6),
        firstConcessionBps: Math.floor(Math.random() * 10_001),
        concessionDecayBps: Math.floor(Math.random() * 10_001),
      };

      let state = openingState(fuzzPolicy);
      for (let turn = 0; turn < 25; turn++) {
        const wild = BigInt(Math.floor(Math.random() * 1_000)) * 1_000_000n;
        const offer = Math.random() < 0.1 ? -wild : wild;
        const decision = evaluateOffer(fuzzPolicy, state, offer);
        assert.ok(
          decision.priceMinor >= fuzzPolicy.floorPriceMinor,
          `floor breached: ${decision.priceMinor} < ${fuzzPolicy.floorPriceMinor}`,
        );
        checks++;
        if (decision.kind === "counter") state = decision.state;
      }
    }
    assert.ok(checks > 9_000, `expected a meaningful number of assertions, ran ${checks}`);
  });
});
