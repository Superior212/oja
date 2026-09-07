/**
 * HTTP entry point.
 *
 * Node's built-in http server, no framework. This process does three things:
 * serve the WhatsApp webhook, run the settlement reconciler, and expose a
 * health check.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadConfig } from "./config.ts";
import { MooveClient } from "./moove/client.ts";
import { MemoryOrderStore } from "./orders/memory-store.ts";
import { PollingSettlementWatcher } from "./reconciler/settlement-watcher.ts";
import {
  extractMessages,
  isValidSignature,
  SeenMessages,
  verifyChallenge,
  type InboundMessage,
} from "./whatsapp/webhook.ts";

const config = loadConfig();
const client = new MooveClient({ apiKey: config.mooveApiKey, baseUrl: config.mooveApiBase });
const store = new MemoryOrderStore();
const seen = new SeenMessages();

const reconciler = new PollingSettlementWatcher({
  client,
  store,
  ttlMs: config.reconcileTtlMinutes * 60_000,
  onSettled: async (event) => {
    // Where the "payment confirmed" message goes out to the buyer, and the
    // order lands on the merchant's dashboard as ready to fulfil.
    console.info(
      `[settled] order=${event.orderId} amount=${event.receivedAmount} tx=${event.transactionUrl ?? "n/a"}`,
    );
  },
});

async function handleInbound(message: InboundMessage): Promise<void> {
  // Wire the conversation loop in here: load or open an order for this buyer,
  // run the model with TOOLS from agent/tools.ts, and let relay_offer and
  // create_checkout do the pricing and settlement work.
  console.info(`[inbound] from=${message.from} text=${JSON.stringify(message.text)}`);
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/health") {
    return send(res, 200, { ok: true });
  }

  if (url.pathname === "/webhook/whatsapp" && req.method === "GET") {
    const { status, body } = verifyChallenge(url.searchParams, config.whatsappVerifyToken);
    res.writeHead(status, { "Content-Type": "text/plain" });
    return void res.end(body);
  }

  if (url.pathname === "/webhook/whatsapp" && req.method === "POST") {
    return void collectBody(req).then((raw) => {
      const appSecret = process.env.WHATSAPP_APP_SECRET;
      if (appSecret && !isValidSignature(raw, req.headers["x-hub-signature-256"] as string, appSecret)) {
        return send(res, 401, { error: "bad signature" });
      }

      // Acknowledge first. Meta retries anything slow, and a retry means the
      // buyer gets answered twice.
      send(res, 200, { received: true });

      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return console.warn("[webhook] unparseable body");
      }

      for (const message of extractMessages(payload)) {
        if (!seen.admit(message.messageId)) continue;
        void handleInbound(message).catch((error) =>
          console.error(`[webhook] handler failed: ${error?.message ?? error}`),
        );
      }
    });
  }

  send(res, 404, { error: "not found" });
});

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function collectBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

server.listen(config.port, () => {
  reconciler.start();
  console.info(`Oja listening on :${config.port}`);
  console.info(`Moove API: ${config.mooveApiBase}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    reconciler.stop();
    server.close(() => process.exit(0));
  });
}
