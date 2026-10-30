# HubDeck connectors

Components that HubDeck customers run on their own side, for example in their own Cloudflare account or on their own servers. Each connector connects a customer system to a hosted HubDeck app.

## Scope

- **Customer-side only.** Hosted application code lives elsewhere and is not published here.
- **Protocol only.** A connector relays data between the customer's system and HubDeck over a documented, versioned, signed protocol. It contains no application logic.
- **Small and stable.** Customers update their copy themselves, so connectors change rarely and HubDeck keeps supporting every protocol version it has shipped.

## Connectors

| Connector | Status | Purpose |
|---|---|---|
| `hubdeckmail/` | Planned | Cloudflare Worker in the customer's account: receives mail for their domain through Email Routing and sends replies through Email Sending, on behalf of a hosted HubDeck app |

## Licence

Apache License 2.0. See [LICENSE](LICENSE).
