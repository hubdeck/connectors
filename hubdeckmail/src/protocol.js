// HubDeckMail protocol, version 1.
//
// Every request between the HubDeck app and this relay, in both directions,
// carries three headers:
//   X-HubDeckMail-Version:   1
//   X-HubDeckMail-Timestamp: <unix seconds>
//   X-HubDeckMail-Signature: hex(HMAC-SHA256(RELAY_SECRET, timestamp + "." + body))
// The body of a GET request is the empty string. Receivers reject a request
// whose timestamp is more than 5 minutes off or whose signature does not match.

export const PROTOCOL_VERSION = 1;
export const MAX_SKEW_SECONDS = 300;

const encoder = new TextEncoder();

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(text));
  return [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Headers for a request whose body is `body` ("" for GET). */
export async function sign(secret, body, now = Date.now()) {
  const timestamp = String(Math.floor(now / 1000));
  return {
    "X-HubDeckMail-Version": String(PROTOCOL_VERSION),
    "X-HubDeckMail-Timestamp": timestamp,
    "X-HubDeckMail-Signature": await hmacHex(secret, `${timestamp}.${body}`),
  };
}

/** Returns { ok: true } or { ok: false, reason }. */
export async function verify(secret, headers, body, now = Date.now()) {
  const version = Number(headers.get("X-HubDeckMail-Version"));
  const timestamp = headers.get("X-HubDeckMail-Timestamp") || "";
  const signature = headers.get("X-HubDeckMail-Signature") || "";
  if (!version || !timestamp || !signature) return { ok: false, reason: "missing headers" };
  if (!/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) return { ok: false, reason: "stale" };
  const expected = await hmacHex(secret, `${timestamp}.${body}`);
  if (expected.length !== signature.length) return { ok: false, reason: "bad signature" };
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0 ? { ok: true } : { ok: false, reason: "bad signature" };
}

export function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text) {
  return Uint8Array.from(atob(text), c => c.charCodeAt(0));
}
