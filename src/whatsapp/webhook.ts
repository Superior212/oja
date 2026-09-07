/**
 * WhatsApp Business Cloud API webhook.
 *
 * Two responsibilities, both boring on purpose:
 *   GET  - the one-time verification handshake Meta requires
 *   POST - inbound messages, acknowledged immediately and processed off the
 *          request path
 *
 * Meta retries any webhook it does not get a fast 200 for, and a retried
 * message means a buyer sees the agent answer twice. So this returns 200 first
 * and does the thinking afterwards.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface InboundMessage {
  /** Buyer's WhatsApp id, E.164 without the plus. */
  from: string;
  /** Meta's message id, used for idempotency. */
  messageId: string;
  text: string;
  timestamp: string;
}

export interface WebhookHandlerOptions {
  verifyToken: string;
  /** Meta App Secret. When set, every POST body is signature-checked. */
  appSecret?: string;
  onMessage: (message: InboundMessage) => Promise<void>;
  logger?: Pick<Console, "warn" | "error">;
}

export function verifyChallenge(
  query: URLSearchParams,
  verifyToken: string,
): { status: number; body: string } {
  const mode = query.get("hub.mode");
  const token = query.get("hub.verify_token");
  const challenge = query.get("hub.challenge");
  if (mode === "subscribe" && token === verifyToken && challenge) {
    return { status: 200, body: challenge };
  }
  return { status: 403, body: "forbidden" };
}

/** Meta signs each body as sha256=<hex hmac>. Constant-time compare, always. */
export function isValidSignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(header.slice("sha256=".length), "hex");
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * Pull the text messages out of a Cloud API payload.
 *
 * The payload is deeply nested and every level is optional, so this walks it
 * defensively and drops anything that is not a plain text message. Status
 * callbacks (delivered, read) come through the same webhook and are ignored here.
 */
export function extractMessages(payload: unknown): InboundMessage[] {
  const messages: InboundMessage[] = [];
  const entries = get(payload, "entry");
  if (!Array.isArray(entries)) return messages;

  for (const entry of entries) {
    const changes = get(entry, "changes");
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = get(change, "value");
      const list = get(value, "messages");
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        if (get(raw, "type") !== "text") continue;
        const from = asString(get(raw, "from"));
        const messageId = asString(get(raw, "id"));
        const text = asString(get(get(raw, "text"), "body"));
        const timestamp = asString(get(raw, "timestamp"));
        if (from && messageId && text) messages.push({ from, messageId, text, timestamp });
      }
    }
  }
  return messages;
}

/** Tracks message ids already handled, so Meta's retries do not double-answer. */
export class SeenMessages {
  readonly #seen = new Set<string>();
  readonly #max: number;

  constructor(max = 10_000) {
    this.#max = max;
  }

  /** Returns true the first time an id is offered, false on every repeat. */
  admit(messageId: string): boolean {
    if (this.#seen.has(messageId)) return false;
    if (this.#seen.size >= this.#max) {
      const oldest = this.#seen.values().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
    this.#seen.add(messageId);
    return true;
  }
}

function get(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
