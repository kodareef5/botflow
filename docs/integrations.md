# Hosted integration contracts

The hosted manager's project **Integrations** tab owns two independent channels:
signed outbound webhooks and provider-neutral email bridges. Both are manager overlays;
they do not add fields to `board.yaml` or card files. No runtime package, SMTP password,
OAuth token, or provider SDK is required by botflow.

## Outbound webhooks

Only a company owner can create, rotate, replay, or revoke a webhook. A webhook has an
exact allow list and deny list of project event action names. An empty allow list means
all events; the deny list always wins. The signing secret is returned when the endpoint
is created or rotated and is not redisplayed in the integration list. It is also present
in owner-only company exports so a restored receiver can keep verifying signatures.

Every event is serialized once and that exact body is retained through automatic retry
and operator replay:

```json
{
  "schema": "botflow.webhook.v1",
  "id": "evt_p-example_42",
  "project": { "id": "p-example" },
  "event": {
    "sequence": 42,
    "occurred_at": "2026-08-20T12:00:00.000Z",
    "actor": "agent-1",
    "action": "move",
    "card_id": "012",
    "detail": "todo → doing"
  }
}
```

The request is an `application/json` POST with these headers:

| Header | Meaning |
|---|---|
| `X-Botflow-Delivery` | Stable random id across automatic attempts; a replay gets a new id |
| `X-Botflow-Event` | Exact event action |
| `X-Botflow-Timestamp` | Unix seconds used by the signature |
| `X-Botflow-Signature-256` | `sha256=<hex HMAC>` |

Verify `HMAC-SHA256(secret, timestamp + "." + exactRequestBody)` before parsing JSON.
Reject timestamps outside a short tolerance and remember delivery ids long enough to
reject replay. Compare the supplied and computed MACs in constant time. Return any 2xx
only after the receiver has durably accepted the event.

Network errors, 408, 425, 429, and 5xx retry at approximately 1 minute, 5 minutes,
30 minutes, 2 hours, and 12 hours, with a maximum of six attempts. A bounded
`Retry-After` may lengthen the delay. Five consecutive failures open a 15-minute
circuit. A success resets it; an owner replay is one explicit half-open probe. Delivery
history is cursor-paginated and an operator can replay its frozen payload. A due batch
is leased atomically before the first network await, so interleaved Durable Object turns
cannot both retain the same batch tail. Delivery is still at-least-once: a crash after
the receiver accepts but before botflow records success retries the same stable
`X-Botflow-Delivery`, which receivers must deduplicate.

### Webhook threat model

- Production endpoints must use HTTPS. Literal loopback, private, link-local,
  metadata, special-use, and non-HTTP(S) targets are rejected before a request.
- Redirects are manual and revalidated on every hop. Only 307 and 308 are followed;
  301, 302, and 303 would change the signed POST semantics and are terminal failures.
- Requests have bounded time, redirect, retry, response, endpoint-count, event-filter,
  and history-page limits. Response bodies are not retained.
- URL validation cannot observe DNS resolution. Cloudflare's edge does not route to a
  customer's private LAN; anyone embedding workerd in a network must also enforce an
  egress firewall against DNS rebinding and private destinations.
- Treat signing secrets and delivery payloads as credentials. Rotation is immediate;
  revocation cancels queued deliveries while retaining owner-visible history.

## Inbound email bridge

Botflow intentionally does not accept raw MIME or pretend every email provider signs
callbacks the same way. An owner creates a route fixed to one of two authorities:

- `create`: create an ordinary card, optionally in one configured lane/substate;
- `comment`: append a comment to one card chosen when the route is created.

The UI returns a secret endpoint once:

```text
POST /api/email/inbound/<project-id>/<bfmail-token>
```

The provider bridge must verify its provider's webhook signature first, discard active
HTML, bound attachment handling outside botflow, and submit this normalized JSON:

```json
{
  "messageId": "provider-stable-id",
  "from": "Sender <sender@example.com>",
  "subject": "Card title or comment subject",
  "text": "Plain text body"
}
```

`messageId` is mandatory and deduplicated per route for 90 days, so an ordinary
provider retry returns the original result without repeating the card mutation. Tokens are stored only as SHA-256
hashes. Input size, text fields, route count, and accepted messages per route/hour are
bounded. Revocation is immediate. The fixed operation is the capability's entire
authority; email content cannot select another project, lane, card, actor, or action.

The token appears in the URL and may therefore appear in proxy access logs. Redact the
path in bridge and edge logs, use TLS, and rotate by revoking and creating a new route if
it is exposed.

## Outbound email bridge

An owner configures recipients and exact event allow/deny lists. Matching events enter a
durable outbox as versioned `botflow.email.outbound.v1` payloads. Botflow does not send
them itself. Set the Worker variable `EMAIL_BRIDGE_USERNAME` to one dedicated `kind: bot`
member. That named bot, when it has write access to the project, leases due work using
its normal API key. Owners retain the recovery/testing path; every other bot and human
is refused even when it can otherwise write the project:

```http
POST /api/projects/<project-id>/email/outbox/claim
Authorization: Bearer bfk_…
Content-Type: application/json

{"limit":10}
```

Each returned item contains `id`, `leaseToken`, `leaseUntil`, `attempt`, and `payload`.
The payload carries `message.to`, `message.subject`, `message.text`, and the source event.
After the provider call, acknowledge the lease:

```http
POST /api/projects/<project-id>/email/outbox/<id>/ack
Authorization: Bearer bfk_…
Content-Type: application/json

{"leaseToken":"lease_…","status":"sent"}
```

Status may be `sent`, `retry`, or `failed`. Retry accepts an optional bounded
`retryAfterSeconds`; otherwise botflow applies its own backoff and six-attempt ceiling.
A lease token is single-use. If a bridge crashes, the five-minute lease expires and a
later claim receives a new token. This is at-least-once delivery: use the outbox `id` as
a provider idempotency key where supported, because a provider may accept mail just
before the bridge crashes without acknowledging it.

The bridge owns provider credentials, callback verification, SPF/DKIM/DMARC alignment,
bounces, complaints, suppression lists, unsubscribe policy, and final delivery. Give it
a dedicated `kind: bot`, project-scoped, `role: write` member, set
`EMAIL_BRIDGE_USERNAME` to that member's username, and mint its key from **Settings →
Members → + key**; the bridge never needs a human password or owner role. Leaving the
variable unset is fail-closed for bots: only an owner can claim or acknowledge outbox
work.

## Company export and restore

Company export version 4 carries each project's active integration configuration under
the versioned `botflow.integrations.v1` schema. That includes webhook URLs, filters, and
signing secrets; inbound email route operation, target, actor, and SHA-256 token hash;
and outbound email recipients and filters. Revoked configuration is omitted. The export
already contains member password hashes, API-key hashes, and share capabilities, so this
is one more reason to encrypt it at rest and restrict it like a credential bundle.

An inbound route's raw `bfmail_…` bearer token is never recoverable from botflow and is
not placed in an export. A retained raw token continues to work after restore because
its hash is preserved; update the endpoint to use the newly assigned project id. If the
raw token was lost, revoke the restored route and create another.

Project ids are remapped during a company restore. Botflow therefore starts every
restored integration with clean operational state:

- webhook failure counters and circuits reset, and delivery/replay history is empty;
- inbound provider-message dedupe records are empty;
- outbound email messages, attempts, leases, errors, and sent history are empty.

This prevents an event body frozen with an old project id from being delivered as if it
belonged to a new project. Back up provider-side delivery records separately if they are
part of your audit requirements.

The integration tables are additive SQLite tables created by the existing `ProjectDO`
on first activation. Deploying this release does not rename a Durable Object class,
change its migration tag, delete a board, or require an authentication reset.
