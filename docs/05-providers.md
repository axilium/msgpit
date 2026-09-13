# Providers

Each provider lives under its own route prefix, and the paths after that prefix mirror the real
API exactly. So the only thing your application changes is the host part of the base URL.

Which providers are enabled in your instance, and what each supports, is visible at
`GET /api/providers` and in the sidebar.

## Spryng

We emulate **API v2**. Not v1: it used a different envelope and wanted numbers *without* a leading
plus, so pointing a v1 client at this will not work.

**Base URL**

```
http://msgpit:8080/spryng/v2
```

The official PHP SDK accepts a base URL with a path and does not validate the host or scheme, so
this is a drop-in with no patching.

**Authentication** is `X-Api-Key`, not a bearer token. Some pages of the Spryng documentation
write the header as `Api-Key` without the prefix; msgpit accepts both. Most GET endpoints also
carry an `AccountReference` header, while the send endpoint takes the account in the body as
`accountReference` instead.

**Implemented endpoints**

| Method | Path | Status |
|---|---|---|
| POST | `/v2/messages` | 202 |
| GET | `/v2/balance` | 201 |

Both status codes are what the real API returns, odd as they look. The send endpoint answers 202
because acceptance is not delivery, and the documented success status for balance really is 201.

**Recipients** are objects with an `msisdn` in E.164 *with* a plus. One request can carry up to
50,000 of them and returns one `requestId` plus one message id per recipient. msgpit stores one
message per recipient, sharing the request id as `batchId`.

**Variables** in the body text are written between square brackets (`[name]`) and substituted per
recipient. msgpit does the substitution, so the stored body is what that recipient would actually
receive, and the segment count reflects it.

**Errors** use `{"errors":[{"errorCode":..., "errorMessage":...}]}`. There is no 422: validation
failures are 400.

**Delivery reports** have no callback URL in the send request, because Spryng configures webhooks
account-wide. Set `MSGPIT_SPRYNG_DLR_URL` to the endpoint in your application. The payload msgpit
sends is PascalCase (`RequestId`, `Messages[].MessageId`, `MessageParts`, `MessageCoding`), unlike
the rest of the API, and drops the leading plus from the number, because that is what Spryng does.

Full API notes, including the casing inconsistencies worth knowing about, are in
`src/Provider/Spryng/CLAUDE.md` in the repository.

## Adding one

A provider is a class implementing `Provider`, plus optional capability interfaces for delivery
reports and error scenarios. It parses the request, validates the required fields and the shape of
the authentication, maps to `Message` objects and builds the provider-shaped response. It never
touches storage and never makes an HTTP call.

The core has no knowledge of any concrete provider, so adding one is a new directory and a line in
`providers.php`. The contract test picks it up automatically from its fixtures. Steps are in the
repository README.
