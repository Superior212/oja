import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MooveClient } from "../src/moove/client.ts";
import {
  MooveAuthError,
  MooveRateLimitError,
  MooveScopeError,
  MooveValidationError,
} from "../src/moove/errors.ts";
import { parseAmount, formatAmount, applyBps, MoneyError } from "../src/moove/money.ts";

const noSleep = async () => {};

function stubFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const spec = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(JSON.stringify(spec.body), {
      status: spec.status,
      headers: { "Content-Type": "application/json", ...spec.headers },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

describe("money", () => {
  test("parses and formats USDC round trip", () => {
    assert.equal(parseAmount("12.5", 6), 12_500_000n);
    assert.equal(formatAmount(12_500_000n, 6), "12.5");
    assert.equal(formatAmount(12_000_000n, 6), "12");
    assert.equal(formatAmount(1n, 6), "0.000001");
  });

  test("rejects more precision than the token supports, instead of rounding", () => {
    assert.throws(() => parseAmount("1.1234567", 6), MoneyError);
  });

  test("rejects junk", () => {
    assert.throws(() => parseAmount("abc", 6), MoneyError);
    assert.throws(() => parseAmount("-1.00", 6), MoneyError);
  });

  test("applyBps rounds half up and stays in integers", () => {
    assert.equal(applyBps(1_000_000n, 3000), 300_000n);
    assert.equal(applyBps(1n, 5000), 1n); // 0.5 rounds up
  });
});

describe("MooveClient", () => {
  test("sends the API key header and hits the versioned path", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: { id: "pl_1", url: "https://x" } }]);
    const client = new MooveClient({ apiKey: "k_test", fetch: fetchImpl, sleep: noSleep });

    const created = await client.createPaymentLink({ toAmount: "1.5", maxUsage: 1 });

    assert.equal(created.id, "pl_1");
    assert.equal(calls[0]!.url, "https://api.moove.xyz/v1/payment-link");
    const headers = calls[0]!.init!.headers as Record<string, string>;
    assert.equal(headers["X-API-Key"], "k_test");
    assert.equal(JSON.parse(calls[0]!.init!.body as string).toAmount, "1.5");
  });

  test("maps documented status codes to distinct error types", async () => {
    const cases: Array<[number, unknown]> = [
      [401, MooveAuthError],
      [403, MooveScopeError],
      [422, MooveValidationError],
    ];
    for (const [status, ErrorType] of cases) {
      const { fetchImpl } = stubFetch([
        { status, body: { errors: [{ message: "nope", code: "E" }] } },
      ]);
      const client = new MooveClient({ apiKey: "k", fetch: fetchImpl, sleep: noSleep, maxRetries: 0 });
      await assert.rejects(
        () => client.listPaymentLinks(),
        (error: unknown) => error instanceof (ErrorType as new () => Error),
        `status ${status} should map to its own error type`,
      );
    }
  });

  test("does not retry a 403, because retrying a scope error just burns rate limit", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 403, body: { errors: [{ message: "scope" }] } }]);
    const client = new MooveClient({ apiKey: "k", fetch: fetchImpl, sleep: noSleep, maxRetries: 3 });
    await assert.rejects(() => client.listPaymentLinks(), MooveScopeError);
    assert.equal(calls.length, 1);
  });

  test("retries a 429 and then succeeds", async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 429, body: { errors: [{ message: "slow down" }] }, headers: { "retry-after": "0" } },
      { status: 200, body: { data: [], limit: 10, offset: 0, nextOffset: null } },
    ]);
    const client = new MooveClient({ apiKey: "k", fetch: fetchImpl, sleep: noSleep, maxRetries: 2 });
    const page = await client.listPaymentLinks();
    assert.equal(page.data.length, 0);
    assert.equal(calls.length, 2);
  });

  test("gives up on a 429 once retries are exhausted", async () => {
    const { fetchImpl } = stubFetch([
      { status: 429, body: { errors: [{ message: "slow down" }] }, headers: { "retry-after": "0" } },
    ]);
    const client = new MooveClient({ apiKey: "k", fetch: fetchImpl, sleep: noSleep, maxRetries: 1 });
    await assert.rejects(() => client.listPaymentLinks(), MooveRateLimitError);
  });

  test("builds the status and offset query string", async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 200, body: { data: [], limit: 10, offset: 20, nextOffset: null } },
    ]);
    const client = new MooveClient({ apiKey: "k", fetch: fetchImpl, sleep: noSleep });
    await client.listPaymentLinks({ status: "completed", offset: 20 });
    assert.equal(calls[0]!.url, "https://api.moove.xyz/v1/payment-link?status=completed&offset=20");
  });

  test("pages through every result", async () => {
    const { fetchImpl } = stubFetch([
      { status: 200, body: { data: [{ id: "a" }], limit: 10, offset: 0, nextOffset: 10 } },
      { status: 200, body: { data: [{ id: "b" }], limit: 10, offset: 10, nextOffset: null } },
    ]);
    const client = new MooveClient({ apiKey: "k", fetch: fetchImpl, sleep: noSleep });
    const ids: string[] = [];
    for await (const link of client.iteratePaymentLinks()) ids.push(link.id);
    assert.deepEqual(ids, ["a", "b"]);
  });

  test("rejects an over-long description before spending an API call", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: {} }]);
    const client = new MooveClient({ apiKey: "k", fetch: fetchImpl, sleep: noSleep });
    await assert.rejects(() =>
      client.createPaymentLink({ toAmount: "1", description: "x".repeat(501) }),
    );
    assert.equal(calls.length, 0, "should fail locally, not at the API");
  });
});
