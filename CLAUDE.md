# msgpit

Local catcher for outgoing SMS, push and other messages - Mailpit, but for message provider APIs.
Runs as a service in Docksal projects. Apps point their provider base URL to msgpit instead of the
real provider; msgpit accepts the request, stores it, returns a realistic provider response and shows
everything in a web UI.

## Goals

- Drop-in: production code stays identical, only the provider base URL differs per environment.
- Provider-agnostic core; every provider is a plugin. Adding a provider must never require core changes.
- Make message costs and edge cases visible locally (segments, encoding, delivery reports, failures).
- Tiny, dependency-free image that is trivial to add to any Docksal project.

## Non-goals

- No real delivery, ever. The only outbound HTTP msgpit makes is delivery-report callbacks to the app.
- No credential validation (only check that auth has the right *shape*).
- No inbound messages, no multi-user, no auth on the UI, no persistence guarantees.
- No full API coverage per provider: only the endpoints our apps actually use.

## Tech stack and constraints

- PHP 8.3, `declare(strict_types=1)` everywhere, `final` classes by default, `readonly` where possible.
- No framework. No runtime Composer dependencies.
- Runtime must NOT require `vendor/`: `public/index.php` registers its own PSR-4 autoloader for `src/`.
  Composer is only used for dev tooling (PHPUnit, PHPStan). This keeps the image small and allows
  mounting the source over `/app` during development.
- Server: PHP built-in server, `PHP_CLI_SERVER_WORKERS=16 php -S 0.0.0.0:8080 -t public public/index.php`.
  Each open SSE connection holds a worker for as long as the tab is open, hence the headroom.
- Storage: SQLite via PDO. DB file at `$MSGPIT_DB` (default `/data/msgpit.sqlite`). Schema is created on
  boot if missing. Losing data on container reset is acceptable.
- UI: vanilla JS/CSS in `public/ui/`, no build step. Live updates via SSE (`GET /api/stream`),
  so a captured message shows up instantly. No websocket: we only push server to client, and
  hand-rolling RFC 6455 framing would mean reimplementing a library. Polling is the fallback
  when the stream drops.
- Base image: `php:8.3-cli-alpine` with `pdo_sqlite`. Multi-arch (amd64 + arm64).

## Mail

msgpit also catches SMTP, so a project has one place for everything it sends rather than a mail
catcher beside a message catcher. It is meant to replace Mailpit in our projects, not to compete
with it: no POP3, no link checking, no Outlook compatibility report.

- `Smtp\Session` is the protocol as a state machine, with no sockets in it, so the whole dialogue
  is testable without opening a port. `Smtp\Server` adds the sockets and selects over them; PHP
  here has no pcntl, so connections are multiplexed rather than forked.
- **We advertise neither STARTTLS nor AUTH.** Clients only use what the server offers, and every
  client we care about talks plain when nothing else is on the table. This only ever listens inside
  a development network.
- `Mime\Parser` handles what mail clients send, not two decades of broken mail from the internet.
  It stays small because PHP already does the hard parts: `iconv_mime_decode_headers()` for folding
  and RFC 2047, `quoted_printable_decode()` and `base64_decode()` for transfer encodings, `iconv()`
  for charsets. Never unfold headers yourself before decoding: the whitespace between two
  encoded-words has to disappear rather than become a space, and that is how a subject gets mangled.
- SMTP is **not** a provider. The `Provider` contract is HTTP routes and a listener does not fit in
  it, so mail is core: `provider` is `smtp` and the channel is `email`. Do not invent a fake
  provider for it.
- One message per recipient, as everywhere else, and the **envelope** decides who those are, not
  the To header. That is how delivery works and the only way a Bcc shows up at all.
- MIME parts live in their own table with the content as a BLOB, and pruning takes them along:
  attachments are the bulk of the database.
- The listener is a second process started by `docker-entrypoint.sh`, which restarts it if it dies.
  Both processes write the same SQLite file, hence WAL mode and a busy timeout. The healthcheck
  checks both ports, because a container that answers HTTP while silently accepting no mail is the
  worst of both worlds.
- Docksal projects reach it through the network aliases `mail` and `mailpit`, so the sendmail
  configuration that Docksal's cli image ships (`msmtp ... --host=mail --port=1025`) needs no change.

### Spam scoring

`MSGPIT_SPAMASSASSIN` (`host:port`) points at a spamd, the same spelling Mailpit uses. The protocol
is a REPORT request and a reply with the score and the rules; nothing is installed in our image.

- **Best effort, always.** A daemon that is down, slow or absent means no score, never a failed
  capture. A catcher that drops mail because a side service is unhappy is worse than one that shows
  no number.
- The rule table is the point, not the score: it names which line of a template is costing points.
  A wrapped description belongs to the rule above it, which is the one parsing subtlety here.
- A score computed in isolation has no `Received` headers, no SPF or DKIM and no reputation, so it
  says something about content and nothing about what a real filter would decide. Do not present
  it as a prediction.

## Architecture

```
src/
  Core/       Router, Storage, Message, Channel, Segments, DlrDispatcher, Scenario, ProviderRegistry
  Http/       Request, Response, OutgoingRequest (thin value objects, no PSR-7 dependency)
  Api/        UI/test API controllers
  Provider/
    Spryng/        SpryngProvider.php
    MessageBird/   MessageBirdProvider.php
    Fcm/           FcmProvider.php
providers.php     registry: list of provider classes
public/
  index.php       front controller + autoloader
  ui/             index.html, app.js, style.css
tests/
  Unit/
  Contract/       generic contract test, runs for every provider
  fixtures/<provider>/<case>/  request.json, expected-response.json, expected-messages.json
```

### Rules

1. **Core never references a concrete provider.** Core only knows the `Provider` interface and the
   optional capability interfaces.
2. **Every provider lives under its own route prefix** equal to `Provider::id()`:
   `http://msgpit:8080/spryng/...`, `http://msgpit:8080/twilio/...`. Paths after the prefix mirror the
   real provider API exactly.
3. **Channel belongs to the message, not the provider.** One provider can deliver several channels
   (e.g. CM.com and Twilio: sms + whatsapp).
4. **Always store the raw request** (method, path, headers with secrets masked, body) next to the
   normalized message.
5. **One stored message per recipient.** A request with 3 recipients produces 3 messages sharing one
   `batchId`.

### Domain model

`Message`: `id`, `batchId`, `provider`, `channel` (`sms|push|whatsapp|...`), `from`, `to`, `body`,
`meta` (JSON: push title/data, template info, provider extras), `providerRef` (the id returned to the
app), `status` (`accepted|delivered|failed|...`), `encoding` and `segments` (sms only, computed by
core), `rawRequest`, `createdAt`, `readAt`.

A message is unread until it is opened in the UI. The read state is server-side, so it is shared
between tabs, and it is independent of `status`: marking a message delivered does not make it read.
The count appears in the tab title as `(3) msgpit`.

Desktop notifications are opt-in through the bell in the toolbar, fire only while the tab is
hidden, and collapse a multi-recipient request into one notification. The Notifications API needs
a secure context and Docksal serves http by default, so on http the button says so and offers the
https address rather than failing silently. Keep that fallback: it is the difference between a
feature that looks broken and one that explains itself.

The UI's top bar is dark in both light and dark themes; the workspace below it is the lighter
surface. Colours come from the custom properties at the top of `style.css`, never hardcoded.

### Provider contract

```php
interface Provider
{
    /** Stable id, also the route prefix. Lowercase, a-z0-9 only. */
    public function id(): string;

    /** @return list<Route> method + path pattern + handler */
    public function routes(): array;
}

// Handler signature: fn(Request $request, array $params): Capture
final class Capture
{
    /** @param list<Message> $messages Normalized, one per recipient. May be empty (e.g. token endpoints). */
    public function __construct(
        public readonly array $messages,
        public readonly Response $response,
    ) {}
}

// Optional capabilities: implement only what the provider supports.
interface SupportsDeliveryReports
{
    /** Build the callback request the real provider would send. Null if no callback URL is known. */
    public function deliveryReport(Message $message, DeliveryStatus $status): ?OutgoingRequest;
}

interface SupportsErrorScenarios
{
    /** Provider-specific error response for a generic scenario. */
    public function errorResponse(Scenario $scenario): Response;
}
```

Providers are pure translators: parse request, validate required fields and auth shape, map to
`Message` objects, build the provider-shaped response. They do not touch storage or do HTTP calls.

## Core features

- **Segments** (`Core/Segments`): detect GSM-7 vs UCS-2 (including the GSM-7 extension table, which
  counts double) and compute segments: 160/153 for GSM-7, 70/67 for UCS-2. Show per message in the UI and
  highlight the characters that force UCS-2. Must be thoroughly unit tested.
- **Delivery reports**: UI action "delivered" / "failed" per message. Core asks the provider for the
  callback request and `DlrDispatcher` sends it. Callback URL comes from the original request if the
  provider supports that (e.g. MessageBird `reportUrl`), otherwise from `MSGPIT_<PROVIDER>_DLR_URL`.
  Store and show the callback response status/body in the UI.
- **Error scenarios** (`Core/Scenario`): generic scenarios `InvalidNumber`, `Unauthorized`,
  `RateLimited`, `ServerError`. Triggered by magic recipient numbers (`+31600000001` invalid number,
  `+31600000002` server error, ...; list defined in one place in core) or by a one-shot UI toggle
  "next request fails with X". Only applies to providers implementing `SupportsErrorScenarios`.
- **Auth shape check**: provider checks the expected auth mechanism is present (Bearer, Basic,
  AccessKey header, token in body). Missing auth returns the provider's real 401 response.

## HTTP API

| Route | Purpose |
|---|---|
| `/{provider}/...` | Emulated provider endpoints |
| `GET /` | UI |
| `GET /api/messages?provider=&channel=&to=&since=` | List messages (newest first) |
| `GET /api/messages/{id}` | Message detail incl. raw request and DLR history |
| `DELETE /api/messages` | Clear all |
| `POST /api/messages/{id}/read` | Mark one message read |
| `POST /api/messages/read` | Mark everything read |
| `POST /api/messages/{id}/dlr` | `{"status":"delivered"}` send delivery report |
| `POST /api/scenario` | `{"scenario":"ServerError"}` one-shot failure for next provider request |
| `GET /api/providers` | Enabled providers and their capabilities |
| `GET /api/scenarios` | Scenario catalogue with the magic numbers, read from the code |
| `GET /api/docs` and `GET /api/docs/{slug}` | Reference pages from `docs/` as Markdown |
| `GET /api/stream` | SSE stream of new messages and status changes |
| `GET /healthz` | Health check |

The `/api` routes are also meant for integration tests in consuming projects (assert that a message
was sent, then clear).

## Configuration (env)

| Variable | Default | |
|---|---|---|
| `MSGPIT_DB` | `/data/msgpit.sqlite` | SQLite path |
| `MSGPIT_PROVIDERS` | all | Comma-separated provider ids to enable |
| `MSGPIT_MAX_MESSAGES` | `1000` | Oldest messages are pruned beyond this |
| `MSGPIT_<PROVIDER>_DLR_URL` | - | Callback URL for delivery reports, e.g. `http://web/sms-status.php` |
| `MSGPIT_<PROVIDER>_DLR_HEADER` | - | Header name authenticating that callback |
| `MSGPIT_<PROVIDER>_DLR_SECRET` | - | Its value. Both or neither |

## Adding a provider (checklist)

1. Create `src/Provider/<Name>/<Name>Provider.php` implementing `Provider` (+ capabilities if supported),
   and `src/Provider/<Name>/CLAUDE.md` documenting the API as described under "Providers".
2. Implement only the endpoints our apps use; mirror path, status codes, headers and body shape of the
   real API.
3. Add fixtures in `tests/fixtures/<id>/<case>/` based on the official API docs. Put the source URL of
   the docs in `tests/fixtures/<id>/README.md`.
4. Register the class in `providers.php`.
5. Run `fin exec composer test`: the contract test picks up the new provider automatically.
6. Document the base URL and any SDK caveats (e.g. SDK does not allow a base URL with a path) in
   `README.md` under "Providers".

## Development (Docksal)

This repo is itself a Docksal project: `cli` for tooling, `msgpit` built from the repo `Dockerfile`
with the source mounted, so changes are live without rebuilding.

```bash
fin up                          # UI at http://msgpit.docksal.site
fin exec composer install
fin exec composer test          # PHPUnit
fin exec composer stan          # PHPStan (level max)
fin config                      # show merged Docksal config when debugging
```

Manual testing: send requests with curl from the `cli` container to `http://msgpit:8080/<provider>/...`.

## Testing

- Unit tests for core (Segments, Router, Storage, Scenario, Docs).
- `composer test` runs PHPUnit and the Node tests for the Markdown renderer.
- Contract test (`tests/Contract`) iterates over all registered providers and all fixture cases:
  send request through the router, assert response status/body and the normalized messages.
- Every bug fix in a provider gets a fixture case that reproduces it.
- Tests run against an in-memory SQLite database.

## Release

Image: `ghcr.io/raymondsteffann/msgpit`, built for amd64 and arm64.

- **Every push to `main` releases.** `.github/next-version.sh` derives the version from the
  conventional commits since the last `v*` tag: a breaking change (`!` or `BREAKING CHANGE`) bumps
  major, `feat:` bumps minor, anything else bumps patch. The workflow then tags the commit, creates
  the GitHub release, and pushes `X.Y.Z`, `X.Y`, `X` and `latest`.
- **Every push to `dev`** publishes `:dev` and `:dev-<sha>`. No tag, no release.
- Nothing is versioned by hand. Changing how the version is decided means changing that script, and
  `tests/Shell/next-version.test.sh` runs the real script against throwaway repositories.
- Consuming projects pin the major tag (`:1`) through `${MSGPIT_IMAGE:-...}`, so a project can
  point at `:dev` from `docksal-local.env` without touching shared config.
- Distribution is a yml snippet in the README, deliberately not a Docksal addon: `fin addon install`
  only reads from a hardcoded `master` branch on raw.githubusercontent.com, which is more machinery
  than a ten line service block deserves.

### The image

- Runs as `www-data`. `docker-entrypoint.sh` starts as root only to take ownership of `/data`,
  then drops privileges with `su-exec`. This is what lets an existing volume from an older,
  root-only version keep working, and it is why there is no `USER` line in the Dockerfile.
- Ships `docs/`, because the UI serves the reference pages from it. Forgetting this leaves the
  Reference section empty in the published image while it works fine locally, where the source is
  mounted over `/app`.
- Has a `HEALTHCHECK`. `fin up` fails the **whole project** if any container is unhealthy, so keep
  it fast and give it a start period.
- CI builds the image and exercises it without the source mounted, which is the one thing local
  development never covers.

## Documentation

Reference documentation lives in `docs/` as plain Markdown, numbered for reading order
(`01-why.md`, `02-getting-started.md`, ...). The same files are served in the UI under
**Reference**, rendered by `public/ui/markdown.js`.

- One source, two audiences: readable on GitHub and in an editor, rendered in the app.
- Write for someone using msgpit, not for someone maintaining it. Maintenance notes belong in
  this file or in a provider's own CLAUDE.md.
- **Never type out a value that lives in code.** Anything the application already knows (the magic
  numbers, provider capabilities) goes in through a `<!-- placeholder -->` filled from the API, so
  the docs cannot drift.
- The renderer handles only the syntax those files use: headings, paragraphs, unordered lists,
  tables, fenced code, inline code, bold, italic and links. Adding syntax means extending
  `markdown.js` and its tests. Do not reach for a Markdown library.
- `tests/Js/markdown.test.mjs` renders every page and fails on leftover Markdown, so a page using
  unsupported syntax is caught.

## Conventions

- Code, comments, commit messages and docs in English.
- PSR-12 formatting. Small classes, no static state except the registry.
- In docs and UI texts use "-" instead of an em dash.
- Keep the image small: no extra system packages without a clear reason.

### Comments

Keep comments compact. A comment earns its place by explaining *why*, not by restating what
the code already says. One line where one line does. No doc blocks that list the parameters
the signature already declares, no section banners, no commented-out code.

### Third-party code

Avoid external packages when we can do without, but do not reimplement a whole package
either. If a dependency looks unavoidable, stop and ask instead of writing our own version
of it. This is about scope, not pride: a narrow helper we fully control beats both a
framework and a half-finished clone of one.

## Do not

- Add runtime Composer dependencies or a framework.
- Reference concrete providers from core.
- Validate credential values or make any outbound call other than delivery-report callbacks.
- Log or display secrets unmasked (mask `Authorization`, API keys and tokens in stored raw requests).
- Reimplement a third-party library ourselves to avoid adding it. Ask first.

## Providers

**Every provider has its own `CLAUDE.md`** next to its class, documenting that provider's API:
base URL, authentication, the endpoints we implement with their status codes, request and response
shapes, error envelopes, delivery reports and any quirks worth remembering. The root CLAUDE.md
only points at it. Keep it current when the provider changes.


### Spryng

We implement Spryng API **version 2**, not version 1. See `src/Provider/Spryng/CLAUDE.md` for the
API details and quirks. Reference material (SDK and docs) lives outside this repo at
`~/Projects/spryng-v2-api`; the v2 API is poorly documented online.
