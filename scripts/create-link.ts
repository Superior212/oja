#!/usr/bin/env node
/**
 * Create one real Moove payment link from the command line.
 *
 * This is the Milestone 1 proof in a single command. Run it, pay the link,
 * and you have a real transaction id to put in the application.
 *
 *   npm run link:create -- 1.50 "Ankara two-piece, size M"
 *
 * Requires MOOVE_API_KEY with the payment_link:create scope.
 */

import { loadConfig } from "../src/config.ts";
import { MooveClient } from "../src/moove/client.ts";
import { formatAmount, parseAmount } from "../src/moove/money.ts";
import {
  MooveAccountNotReadyError,
  MooveAuthError,
  MooveScopeError,
  MooveValidationError,
} from "../src/moove/errors.ts";

const [rawAmount, ...descriptionParts] = process.argv.slice(2);

if (!rawAmount) {
  console.error("Usage: npm run link:create -- <amount> [description]");
  console.error('Example: npm run link:create -- 1.50 "Ankara two-piece, size M"');
  process.exit(1);
}

const config = loadConfig();
const client = new MooveClient({ apiKey: config.mooveApiKey, baseUrl: config.mooveApiBase });

try {
  // Round-trip through minor units so a bad precision fails here, locally,
  // with a clear message, rather than as a 422 from the API.
  const minor = parseAmount(rawAmount, config.settlementTokenDecimals);
  const amount = formatAmount(minor, config.settlementTokenDecimals);

  const description = descriptionParts.join(" ") || "Oja test payment";
  const expirationDate = new Date(Date.now() + 60 * 60_000).toISOString();

  const link = await client.createPaymentLink({
    toAmount: amount,
    description,
    maxUsage: 1,
    expirationDate,
  });

  console.log("");
  console.log("  Payment link created");
  console.log("  --------------------");
  console.log(`  id:      ${link.id}`);
  console.log(`  amount:  ${amount}`);
  console.log(`  expires: ${expirationDate}`);
  console.log(`  url:     ${link.url}`);
  console.log("");
  console.log(`  Watch it settle:  npm run link:watch -- ${link.id}`);
  console.log("");
} catch (error) {
  console.error("");
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof MooveAuthError) {
    console.error("  Check MOOVE_API_KEY. Keys are shown once at creation and cannot be re-read.");
  } else if (error instanceof MooveScopeError) {
    console.error("  This key lacks payment_link:create. Recreate it with the Moove Receive Agent.");
  } else if (error instanceof MooveAccountNotReadyError) {
    console.error("  Your Moove account is not set up to receive payments yet. Finish setup first.");
  } else if (error instanceof MooveValidationError) {
    console.error(
      `  Check the amount precision. SETTLEMENT_TOKEN_DECIMALS is ${config.settlementTokenDecimals}.`,
    );
  }
  console.error("");
  process.exit(1);
}
