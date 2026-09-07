/**
 * Money handling.
 *
 * Every amount inside Oja is a bigint in the settlement token's minor units.
 * Floats never touch a price. The only two places a decimal string exists are
 * the API boundary and the buyer's screen, and both conversions live here.
 *
 * This exists because the Moove API requires amount precision to match the
 * settlement token's decimals. USDC is 6, so 12.5 USDC is 12500000 minor units
 * and must serialise as "12.5" or "12.500000", never as 12.5000000001.
 */

export class MoneyError extends Error {
  override readonly name = "MoneyError";
}

/**
 * Parse a decimal string into minor units.
 * Rejects anything with more fractional digits than the token supports, rather
 * than silently rounding. A price the merchant cannot express is a bug worth
 * surfacing at quote time, not a rounding difference discovered at settlement.
 */
export function parseAmount(decimal: string, decimals: number): bigint {
  assertDecimals(decimals);
  const trimmed = decimal.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new MoneyError(`Not a valid non-negative decimal amount: ${JSON.stringify(decimal)}`);
  }
  const [whole = "0", fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) {
    throw new MoneyError(
      `Amount ${trimmed} has ${fraction.length} decimal places but the settlement token supports ${decimals}`,
    );
  }
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

/** Render minor units as a decimal string with no trailing zero noise. */
export function formatAmount(minor: bigint, decimals: number): string {
  assertDecimals(decimals);
  if (minor < 0n) throw new MoneyError("Negative amounts are not supported");
  if (decimals === 0) return minor.toString();
  const base = 10n ** BigInt(decimals);
  const whole = minor / base;
  const fraction = (minor % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}

/**
 * Multiply by a rate expressed in basis points, rounding half up.
 * Used by the concession curve so discounts stay in integer arithmetic.
 */
export function applyBps(minor: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new MoneyError(`bps must be a non-negative integer, got ${bps}`);
  }
  const numerator = minor * BigInt(bps);
  const half = 10000n / 2n;
  return (numerator + half) / 10000n;
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new MoneyError(`decimals must be an integer between 0 and 36, got ${decimals}`);
  }
}
