# Getting started

msgpit runs as a container next to your application. Point the provider base URL at it and change
nothing else.

## As a Docksal service

In your project's `.docksal/docksal.yml`:

```yaml
services:
  msgpit:
    hostname: msgpit
    image: ghcr.io/<org>/msgpit:1
    volumes:
      - msgpit_data:/data
    labels:
      - io.docksal.virtual-host=msgpit.${VIRTUAL_HOST}
      - io.docksal.virtual-port=8080
    environment:
      - MSGPIT_SPRYNG_DLR_URL=http://web/webhooks/spryng

volumes:
  msgpit_data:
```

`fin up`, and the UI is at `http://msgpit.<project>.docksal.site`. Your application reaches the
API at `http://msgpit:8080`.

## Plain Docker

```bash
docker run -p 8080:8080 ghcr.io/<org>/msgpit:1
```

Pin the major tag. Breaking changes to the provider routes or the `/api` contract get a major
version bump.

## Pointing your application at it

Only the base URL changes. Per environment, so production keeps talking to the real provider:

```php
// config/services.php
'spryng' => [
    'base_url' => env('SPRYNG_BASE_URL', 'https://api.spryng.nl/v2'),
    'api_key' => env('SPRYNG_API_KEY'),
],
```

```dotenv
# .env.local
SPRYNG_BASE_URL=http://msgpit:8080/spryng/v2
SPRYNG_API_KEY=anything
```

The key can be anything. msgpit checks that the header the provider expects is present, never what
is in it. Leave it out entirely and you get the provider's real 401, which is how you find out you
forgot to configure it.

Check that the SDK you use accepts a base URL with a path in it. Some do not, and that is worth
knowing before you debug it. Per-provider notes are under Providers.

## Verifying it works

```bash
curl -X POST http://msgpit:8080/spryng/v2/messages \
  -H 'X-Api-Key: anything' -H 'Content-Type: application/json' \
  -d '{"accountReference":"SPNL0000000","channel":"SMS","from":"Acme",
       "body":{"text":"Hello 👋"},"recipients":[{"msisdn":"+31612345678"}]}'
```

You should get a `202` with a `requestId`, and the message should appear in the UI immediately.
Note that it is flagged UCS-2: the emoji costs you 90 characters of capacity.

## Configuration

| Variable | Default | |
|---|---|---|
| `MSGPIT_DB` | `/data/msgpit.sqlite` | SQLite file |
| `MSGPIT_PROVIDERS` | all | Comma-separated provider ids to enable |
| `MSGPIT_MAX_MESSAGES` | `1000` | Older messages are pruned beyond this |
| `MSGPIT_<PROVIDER>_DLR_URL` | - | Delivery-report callback into your app |

Mount `/data` on a volume if you want captured messages to survive a container restart. Losing
them is a supported outcome, not a failure.
