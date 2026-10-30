# HubDeckMail

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hubdeck/connectors/tree/main/hubdeckmail)

A Cloudflare Worker you deploy to your own Cloudflare account. It connects a domain on Cloudflare to a hosted HubDeck app:

- **Inbound:** Email Routing delivers mail for your addresses to this Worker, which forwards it to HubDeck.
- **Outbound:** HubDeck asks this Worker to send replies, which go out through Cloudflare Email Sending from your own address.

Every request between HubDeck and the Worker is signed with a secret that only the two of them hold.

## Requirements

- A domain on Cloudflare, with Email Routing enabled.
- Email Sending onboarded for that domain (Compute > Email Service > Email Sending), so replies can be sent from it.
- Admin access to the HubDeck app.

## Setup

1. In the HubDeck app, open **Settings > Integrations**, choose **HubDeckMail** and select **Connect**. Copy the three values shown: `HUBDECK_URL`, `INTEGRATION_ID` and `RELAY_SECRET`. The secret is shown only once.
2. Select **Deploy to Cloudflare** above. When asked, enter:

   | Name | Value |
   |---|---|
   | `HUBDECK_URL` | From step 1 |
   | `INTEGRATION_ID` | From step 1 |
   | `RELAY_SECRET` | From step 1 |
   | `ALLOWED_SENDERS` | The addresses HubDeck may send as, comma-separated, for example `support@example.com`. Use `@example.com` to allow every address on the domain. |

3. In the Cloudflare dashboard, open your domain's **Email > Email Routing > Routing rules** and route each support address to the Worker `hubdeckmail` (action **Send to a Worker**).
4. Back in HubDeck, enter the Worker's URL (for example `https://hubdeckmail.<your-subdomain>.workers.dev`) as the relay URL, select **Test**, then add the same addresses to the integration.

Send a message to one of the addresses to check that it arrives as a ticket.

### Deploying without the button

```bash
npm install
npx wrangler secret put RELAY_SECRET
npx wrangler deploy --var HUBDECK_URL:<url> --var INTEGRATION_ID:<id> --var ALLOWED_SENDERS:<addresses>
```

Or set the three variables in `wrangler.jsonc` before `npx wrangler deploy`.

## Behaviour

| Situation | Result |
|---|---|
| HubDeck accepts the message | Delivered as a ticket |
| HubDeck does not handle the address (HTTP 422) | Message is rejected and the sender receives a bounce |
| HubDeck cannot be reached or returns an error | The Worker throws, so the sending server retries later |
| HubDeck asks to send from an address not in `ALLOWED_SENDERS` | Refused (HTTP 403); nothing is sent |
| A request is unsigned, signed with another secret or more than 5 minutes old | Refused (HTTP 401) |

The Worker stores nothing. Mail passes through it and is not kept.

## Changing the secret

Create a new integration in HubDeck to get a new secret, then update the Worker: `npx wrangler secret put RELAY_SECRET` and the `INTEGRATION_ID` variable. Remove the old integration in HubDeck afterwards.

## Protocol (version 1)

All requests carry these headers:

| Header | Value |
|---|---|
| `X-HubDeckMail-Version` | `1` |
| `X-HubDeckMail-Timestamp` | Unix time in seconds |
| `X-HubDeckMail-Signature` | Hex HMAC-SHA256 of `<timestamp>.<body>` with `RELAY_SECRET`; the body of a GET is empty |

| Request | Body | Response |
|---|---|---|
| Worker → `POST <HUBDECK_URL>/hooks/<INTEGRATION_ID>` | `{"type":"inbound","from","to","raw"}`, where `raw` is the base64 message | 202 accepted, 422 address not handled |
| HubDeck → `POST /send` | `{"from","to","reply_to","subject","text","html","headers","attachments":[{"filename","type","content"}]}`, attachment content in base64 | `{"messageId"}` |
| HubDeck → `GET /health` | None | `{"version":1,"sender":[...]}` |

## Development

```bash
npm install
npm test
cp .dev.vars.example .dev.vars   # set RELAY_SECRET
npx wrangler dev
```

Tests need Node 20 or later and no other dependencies.
