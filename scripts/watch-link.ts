#!/usr/bin/env node
/**
 * Poll one payment link until it settles.
 *
 *   npm run link:watch -- <paymentLinkId>
 *
 * Prints the block explorer URL on settlement, which is the evidence a
 * milestone review actually wants to see.
 */

import { loadConfig } from "../src/config.ts";
import { MooveClient } from "../src/moove/client.ts";
import { isSettled } from "../src/reconciler/settlement-watcher.ts";

const linkId = process.argv[2];
if (!linkId) {
  console.error("Usage: npm run link:watch -- <paymentLinkId>");
  process.exit(1);
}

const config = loadConfig();
const client = new MooveClient({ apiKey: config.mooveApiKey, baseUrl: config.mooveApiBase });

const INTERVAL_MS = 5_000;
const DEADLINE = Date.now() + 30 * 60_000;

console.log(`Watching ${linkId}. Ctrl-C to stop.`);

while (Date.now() < DEADLINE) {
  const link = await client.findPaymentLink(linkId);

  if (!link) {
    console.log("  not found yet, still looking");
  } else if (isSettled(link)) {
    console.log("");
    console.log("  Settled");
    console.log("  -------");
    console.log(`  received: ${link.receivedAmount} ${link.token}`);
    console.log(`  to:       ${link.destinationAddress}`);
    console.log(`  tx:       ${link.transactionUrl ?? "not reported"}`);
    console.log("");
    process.exit(0);
  } else {
    console.log(`  status=${link.status} received=${link.receivedAmount ?? "0"}`);
  }

  await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
}

console.log("Deadline reached without settlement.");
process.exit(2);
