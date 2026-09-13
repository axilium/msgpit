# Spryng provider

Emulates the **Spryng API v2**. Not v1: v1 wanted numbers without a leading plus and used a
different envelope entirely. Reference material (SDK, scraped portal docs, OpenAPI) lives outside
this repo at `~/Projects/spryng-v2-api`; the v2 API is poorly documented online.

- Route prefix: `spryng`, so our base URL is `http://msgpit:8080/spryng/v2`.
- Channel: `sms` only.
- Capabilities: `SupportsDeliveryReports`, `SupportsErrorScenarios`.

## Base URL

The real base is `https://api.spryng.nl/v2`; the version sits in the path. The official PHP SDK
takes an optional base URL and only does `rtrim($base, '/') . '/' . ltrim($path, '/')`, so a base
URL **with a path is fine** and plain http works. Consuming projects need no patched SDK: point
the base URL at `http://msgpit:8080/spryng/v2` and everything else stays identical.

## Authentication

`X-Api-Key: <key>`. There is no `Authorization` header and no OAuth. Some doc pages write
`Api-Key` without the prefix, so we accept both. We check the header is present and non-empty and
never look at the value.

Most GET endpoints also carry an `AccountReference` header (format `SPNL` + 7 digits). On
`POST /v2/messages` the account sits in the body as `accountReference` instead. Two doc pages
misspell the header as `AcccountReference`; that is a typo in the docs, not a second header.

## Implemented endpoints

| Method | Path | Status | Notes |
|---|---|---|---|
| POST | `/v2/messages` | **202** | Send. Not 200. |
| GET | `/v2/balance` | **201** | Documented as 201 Created, and amounts are strings. |

The real API has 42 paths (contacts, groups, templates, schedules, throttling, webhooks, inbox,
url-shortener). We only add what our apps actually call.

## Send request

```json
{
    "accountReference": "SPNL0000000",
    "channel": "SMS",
    "from": "Acme",
    "body": {"text": "Your code is 123456"},
    "recipients": [{"msisdn": "+31612345678", "variables": {"name": "Ada"}}]
}
```

- `accountReference`, `channel` (only `SMS`), and `body` are required. `body` needs either `text`
  or a `templateId`.
- `recipients` holds 1 to 50,000 objects; `msisdn` must be E.164 **with** a plus
  (`/^\+[1-9]\d{6,14}$/`).
- `recipients` and `addressBook` are mutually exclusive.
- Optional: `name`, `characterSet` (`Auto`|`GSM`|`Unicode`), `validity`, `messageType`, `metaData`.
- Variables in the text are written between square brackets (`[name]`) and are substituted per
  recipient. We do this substitution so the stored body is what the recipient would actually get.
- The SDK omits empty `variables`/`metaData`, but the live API often receives them as `{}`. Accept
  both.

## Send response

```json
{"data": {"requestId": "8dcad127-bb9c-48fe-9827-db2fe57d53fb",
          "messageIds": ["0929df71-d1ea-4b02-87b2-9789b332a92e"]}}
```

Lowercase UUID v4 with dashes, one messageId per recipient in send order. The `requestId` is our
`batchId`, each messageId the message's `providerRef`. Every response is wrapped in `data`,
**except** `/v2/balance`.

## Errors

```json
{"errors": [{"errorCode": "msisdn_invalid", "errorMessage": "..."}]}
```

- **There is no 422.** Validation failures are **400**. Error codes are snake_case.
- 401 is the only shape verified against the live API:
  `{"errors":[{"errorCode":"UnauthenticatedError","errorMessage":"Request for authenticated route '<path>' was unauthenticated"}]}`.
  The path in the message is dynamic. Doc pages disagree on the casing of the code
  (`unauthenticatedError` 39 times, `UnauthenticatedError` 4 times); the live capture gave the
  capitalised form, so that is what we return.
- 429 is documented only generically: one undisclosed limit across all endpoints, and wait 5
  seconds afterwards. No `X-RateLimit-*` headers exist, but the SDK reads `Retry-After`, so we
  send it.
- 500 is undocumented; we keep the same envelope.

## Delivery reports

Spryng has **no callback URL in the send request**. Webhooks are configured account-wide through
`POST /v2/webhooks/subscriptions`, per event (`sms-message-delivered`, `sms-message-failed`,
`sms-message-received`, `sms-inbound-opted-out`). So our callback URL comes from
`MSGPIT_SPRYNG_DLR_URL`; without it the UI still flips the status but sends nothing.

The callback payload is **PascalCase**, unlike the rest of the API, and drops the leading plus
from the number:

```json
{
  "RequestId": "afe6beb6-...", "AccountReference": "SPNL0000000", "Channel": "SMS",
  "Status": "Delivered",
  "Messages": [{"MessageId": "31b2dbc7-...", "Status": "Delivered", "Reason": "Delivered",
                "Body": "...", "MessageParts": 2, "MessageCoding": "GSM",
                "Msisdn": "447897890440", "Originator": "Acme"}]
}
```

Status values the API uses: `Delivered | Received | Failed | In Progress | Sent`. The `reason`
enum includes `Delivered`, `MsisdnInvalid`, `NetworkFailed`, `OptedOut`, `SendingLimitExceeded`
and more.

## Encoding and segments

Three names for the same thing, one per endpoint. Mirror this, do not normalise it:

| Where | Field | Values |
|---|---|---|
| Send request | `characterSet` | `Auto`, `GSM`, `Unicode` |
| Message response | `characterSet` | `Gsm`, `Unicode` |
| Webhook | `MessageCoding` | `GSM`, `Unicode` |
| Webhook / list | `MessageParts` / `messagePartCount` | integer |

Segment counting itself is core's job (`Core\Segments`), not the provider's.

## Quirks worth remembering

1. Send answers 202, balance answers 201.
2. `data` wrapper everywhere except balance.
3. No `Authorization` header; `X-Api-Key`, tolerant of `Api-Key`.
4. No 422; validation is 400.
5. `GET /v2/requests` uses PascalCase query filters while `GET /v2/messages` uses lowercase.
6. Query arrays repeat the key (`?contactId=a&contactId=b`), never `contactId[]`.
7. Timestamps the SDK sends are `Y-m-d\TH:i:s.v\Z`; the ones the API returns have 7 decimals.
