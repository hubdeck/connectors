// Run: npm test (Node 20 or later; no dependencies).
import { test } from "node:test";
import assert from "node:assert/strict";
import relay, { senderAllowed } from "../src/index.js";
import { fromBase64, sign, toBase64, verify } from "../src/protocol.js";

const SECRET = "ab".repeat(32);
const env = (extra = {}) => ({
  HUBDECK_URL: "https://helpdesk.example.com",
  INTEGRATION_ID: "0123456789abcdef01234567",
  RELAY_SECRET: SECRET,
  ALLOWED_SENDERS: "support@example.com, @billing.example.com",
  ...extra,
});

async function signed(path, body, secret = SECRET) {
  const init = { method: body === undefined ? "GET" : "POST", headers: await sign(secret, body ?? "") };
  if (body !== undefined) init.body = body;
  return new Request(`https://relay.example.workers.dev${path}`, init);
}

async function withFetch(fn, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  try { return await run(); } finally { globalThis.fetch = original; }
}

function inboundMessage(to = "support@example.com") {
  const raw = new TextEncoder().encode(`From: Ann <ann@customer.test>\r\nTo: ${to}\r\nSubject: Help\r\n\r\nHello\r\n`);
  return {
    from: "ann@customer.test", to, raw: new Blob([raw]).stream(), bytes: raw, rejected: null,
    setReject(reason) { this.rejected = reason; },
  };
}

test("protocol: signatures verify, and tampering, wrong secrets and old timestamps fail", async () => {
  const headers = new Headers(await sign(SECRET, "body"));
  assert.deepEqual(await verify(SECRET, headers, "body"), { ok: true });
  assert.equal((await verify(SECRET, headers, "other")).ok, false);
  assert.equal((await verify("cd".repeat(32), headers, "body")).ok, false);
  const old = new Headers(await sign(SECRET, "body", Date.now() - 301_000));
  assert.deepEqual(await verify(SECRET, old, "body"), { ok: false, reason: "stale" });
  assert.deepEqual(await verify(SECRET, new Headers(), "body"), { ok: false, reason: "missing headers" });
  const bytes = new Uint8Array([0, 1, 254, 255]);
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
});

test("inbound: mail is posted to HubDeck, signed, with the raw message", async () => {
  const msg = inboundMessage();
  let call;
  await withFetch(async (url, init) => { call = { url: String(url), init }; return new Response(null, { status: 202 }); },
    () => relay.email(msg, env()));
  assert.equal(call.url, "https://helpdesk.example.com/hooks/0123456789abcdef01234567");
  assert.equal((await verify(SECRET, new Headers(call.init.headers), call.init.body)).ok, true);
  const body = JSON.parse(call.init.body);
  assert.equal(body.type, "inbound");
  assert.equal(body.to, "support@example.com");
  assert.equal(body.from, "ann@customer.test");
  assert.deepEqual(fromBase64(body.raw), msg.bytes);
  assert.equal(msg.rejected, null);
});

test("inbound: HubDeck's 422 bounces the message; other failures throw so the sender retries", async () => {
  const msg = inboundMessage("nobody@example.com");
  await withFetch(async () => new Response("Address not found", { status: 422 }), () => relay.email(msg, env()));
  assert.equal(msg.rejected, "Address not found");
  await assert.rejects(withFetch(async () => new Response("", { status: 503 }), () => relay.email(inboundMessage(), env())), /503/);
  await assert.rejects(relay.email(inboundMessage(), env({ RELAY_SECRET: "" })), /RELAY_SECRET is not set/);
});

test("health: signed requests get the protocol version and allowed senders", async () => {
  const res = await relay.fetch(await signed("/health"), env());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { version: 1, sender: ["support@example.com", "@billing.example.com"] });
  assert.equal((await relay.fetch(await signed("/health", undefined, "cd".repeat(32)), env())).status, 401);
  assert.equal((await relay.fetch(new Request("https://relay.example.workers.dev/health"), env())).status, 401);
});

test("send: a signed request is sent through the binding with binding field names", async () => {
  let sent;
  const e = env({ EMAIL: { async send(m) { sent = m; return { messageId: "<x@example.com>" }; } } });
  const body = JSON.stringify({
    from: "Example Support <support@example.com>", to: "ann@customer.test", reply_to: "support@example.com",
    subject: "Re: Help [#ABC234]", text: "Hi", html: "<p>Hi</p>", headers: { "In-Reply-To": "<m1@customer.test>" },
    attachments: [{ filename: "a.txt", type: "text/plain", content: toBase64(new TextEncoder().encode("hello")) }],
  });
  const res = await relay.fetch(await signed("/send", body), e);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { messageId: "<x@example.com>" });
  assert.equal(sent.replyTo, "support@example.com");
  assert.equal("reply_to" in sent, false);
  assert.equal(new TextDecoder().decode(sent.attachments[0].content), "hello");
  assert.deepEqual(sent.headers, { "In-Reply-To": "<m1@customer.test>" });
});

test("send: unsigned, bad JSON, missing fields and disallowed senders are refused; binding errors are 502", async () => {
  const e = env({ EMAIL: { async send() { throw new Error("domain not onboarded"); } } });
  const mail = (from) => JSON.stringify({ from, to: "ann@customer.test", subject: "Hi", text: "x" });
  assert.equal((await relay.fetch(new Request("https://r.example/send", { method: "POST", body: mail("support@example.com") }), e)).status, 401);
  assert.equal((await relay.fetch(await signed("/send", "{"), e)).status, 400);
  assert.equal((await relay.fetch(await signed("/send", "{}"), e)).status, 400);
  assert.equal((await relay.fetch(await signed("/send", mail("Someone <other@example.com>")), e)).status, 403);
  const failed = await relay.fetch(await signed("/send", mail("Billing <team@billing.example.com>")), e);
  assert.equal(failed.status, 502);
  assert.equal((await failed.json()).error, "domain not onboarded");
});

test("senders: exact addresses and @domain entries; nothing is allowed when unset", () => {
  assert.equal(senderAllowed(env(), "SUPPORT@example.com"), true);
  assert.equal(senderAllowed(env(), "X <a@billing.example.com>"), true);
  assert.equal(senderAllowed(env(), "a@sub.billing.example.com"), false);
  assert.equal(senderAllowed(env(), "sales@example.com"), false);
  assert.equal(senderAllowed(env({ ALLOWED_SENDERS: "" }), "support@example.com"), false);
});
