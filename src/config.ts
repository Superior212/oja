/**
 * Configuration, read once at startup.
 *
 * Keys are never read from source. In production each merchant's key is
 * decrypted per request from the tenant store; the single MOOVE_API_KEY here
 * is the single-merchant path used for local development and the Milestone 1
 * proof scripts.
 */

export interface Config {
  mooveApiKey: string;
  mooveApiBase: string;
  settlementTokenDecimals: number;
  whatsappVerifyToken: string;
  whatsappAccessToken: string;
  whatsappPhoneNumberId: string;
  port: number;
  reconcileTtlMinutes: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    mooveApiKey: required(env, "MOOVE_API_KEY"),
    mooveApiBase: env.MOOVE_API_BASE ?? "https://api.moove.xyz",
    settlementTokenDecimals: int(env.SETTLEMENT_TOKEN_DECIMALS, 6),
    whatsappVerifyToken: env.WHATSAPP_VERIFY_TOKEN ?? "",
    whatsappAccessToken: env.WHATSAPP_ACCESS_TOKEN ?? "",
    whatsappPhoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? "",
    port: int(env.PORT, 3000),
    reconcileTtlMinutes: int(env.RECONCILE_TTL_MINUTES, 60),
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill it in. ` +
        `The Moove key is created in the Dashboard and shown only once.`,
    );
  }
  return value;
}

function int(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw new Error(`Expected an integer, got ${JSON.stringify(raw)}`);
  return parsed;
}
