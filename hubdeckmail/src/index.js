// HubDeckMail relay. Runs in the customer's Cloudflare account and connects
// their domain to a hosted HubDeck app:
//
//   Inbound:  Email Routing -> email() -> POST <HUBDECK_URL>/hooks/<INTEGRATION_ID>
//   Outbound: HubDeck app   -> POST /send -> send_email binding (Email Sending)
//   Check:    HubDeck app   -> GET /health
//
// All requests in both directions are signed with RELAY_SECRET (src/protocol.js).
import { PROTOCOL_VERSION, fromBase64, sign, toBase64, verify } from "./protocol.js";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

export default {
  async email(message, env) {
    assertConfigured(env);
    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    const body = JSON.stringify({ type: "inbound", from: message.from, to: message.to, raw: toBase64(raw) });
    const res = await fetch(hookUrl(env), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await sign(env.RELAY_SECRET, body)) },
      body,
    });
    // 422: HubDeck does not accept mail for this address, so bounce it.
    if (res.status === 422) return message.setReject((await res.text()) || "Address not found");
    // Anything else that is not a success is temporary: throwing makes the
    // sending server retry later.
    if (!res.ok) throw new Error(`HubDeck responded ${res.status}`);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return health(request, env);
    if (url.pathname === "/send" && request.method === "POST") return send(request, env);
    return new Response("HubDeckMail relay", { status: 404 });
  },
};

function assertConfigured(env) {
  for (const name of ["HUBDECK_URL", "INTEGRATION_ID", "RELAY_SECRET"]) {
    if (!env[name]) throw new Error(`${name} is not set`);
  }
}

function hookUrl(env) {
  return new URL(`/hooks/${encodeURIComponent(env.INTEGRATION_ID)}`, env.HUBDECK_URL);
}

async function authorised(request, env, body) {
  if (!env.RELAY_SECRET) return false;
  return (await verify(env.RELAY_SECRET, request.headers, body)).ok;
}

/** ALLOWED_SENDERS: comma-separated addresses, or @domain for a whole domain. */
function allowedSenders(env) {
  return String(env.ALLOWED_SENDERS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

export function senderAllowed(env, from) {
  const address = (/<([^<>]+)>\s*$/.exec(from)?.[1] || from).trim().toLowerCase();
  const domain = address.slice(address.lastIndexOf("@"));
  return allowedSenders(env).some(entry => entry === address || entry === domain);
}

async function health(request, env) {
  if (!await authorised(request, env, "")) return json({ error: "Unauthorized" }, 401);
  return json({ version: PROTOCOL_VERSION, sender: allowedSenders(env) });
}

async function send(request, env) {
  const body = await request.text();
  if (!await authorised(request, env, body)) return json({ error: "Unauthorized" }, 401);
  let mail;
  try { mail = JSON.parse(body); } catch { return json({ error: "Invalid JSON" }, 400); }
  if (!mail.from || !mail.to || !mail.subject) return json({ error: "from, to and subject are required" }, 400);
  if (!senderAllowed(env, mail.from)) return json({ error: "Sender not in ALLOWED_SENDERS" }, 403);
  try {
    const sent = await env.EMAIL.send({
      from: mail.from,
      to: mail.to,
      subject: mail.subject,
      ...(mail.reply_to ? { replyTo: mail.reply_to } : {}),
      ...(mail.text ? { text: mail.text } : {}),
      ...(mail.html ? { html: mail.html } : {}),
      ...(mail.headers ? { headers: mail.headers } : {}),
      ...(mail.attachments?.length ? {
        attachments: mail.attachments.map(a => ({ filename: a.filename, type: a.type, content: fromBase64(a.content) })),
      } : {}),
    });
    return json({ messageId: sent?.messageId || null });
  } catch (err) {
    return json({ error: err?.message || "Send failed" }, 502);
  }
}
