# Email

msgpit catches SMTP as well, so everything an application sends ends up in one place instead of a
mail catcher beside a message catcher. It listens on port 1025 and stores what arrives, the same
way it stores an SMS: one message per recipient, with the raw form kept alongside.

This replaces Mailpit for our own projects. It is not a full mail client: no POP3, no link
checking, no Outlook compatibility report.

## Pointing your project at it

Docksal's `cli` image already sends mail to a host called `mail` on port 1025:

```
sendmail_path = '/usr/bin/msmtp -t --host=mail --port=1025 --from=docker@cli'
```

The msgpit container answers to the network aliases `mail` and `mailpit`, so replacing the mail
service in `.docksal/docksal.yml` is enough. Nothing in your application changes: PHP's `mail()`,
Symfony Mailer with `smtp://mail:1025`, and Laravel with `MAIL_HOST=mailpit` all arrive.

```yaml
services:
  msgpit:
    hostname: msgpit
    image: ${MSGPIT_IMAGE:-ghcr.io/raymondsteffann/msgpit:1}
    volumes:
      - msgpit_data:/data
    networks:
      default:
        aliases:
          - mail
          - mailpit
    labels:
      - io.docksal.virtual-host=msgpit.${VIRTUAL_HOST},msgpit.${VIRTUAL_HOST}.*
      - io.docksal.virtual-port=8080
```

There is no authentication and no TLS, on purpose. A client only uses what the server offers, and
this only ever listens inside a development network. If a client is configured with a username and
password, it simply will not use them.

## What you see

**Preview** renders the html exactly as the recipient would get it, in a sandboxed frame with no
scripts and no access to msgpit. Images the mail carries with it are referenced by `cid:`, which
means nothing to a browser, so msgpit rewrites them to the part they point at. An image the mail
loads from the internet is left alone and will simply not appear when you are offline.

**Text** shows the plain text alternative, when there is one. Worth a look: it is the version that
goes to anyone reading mail without html, and it is the one people forget to keep in step.

**Attachments** lists what was attached, with its type and size, and lets you download it.
Filenames with accents survive.

**Raw** is the message exactly as it came off the wire, headers and encodings included.

## Why the list shows what it shows

For mail the subject is the title and the recipient sits in the preview line, because a list of
identical addresses tells you nothing. For an SMS it is the other way around.

The unread count, the notifications and the filters work the same for mail as for everything else.
Filtering on the channel `email` gives you only mail; `GET /api/messages?channel=email` does the
same over the API.

## What is not there

msgpit accepts a message and stores it. It never delivers, never bounces, and never answers a
delivery status notification. SpamAssassin scoring is a separate feature and is documented with
the rest of the API once it lands.

Every recipient of one mail becomes its own message sharing a `batchId`, and the **envelope**
decides who those recipients are, not the `To` header. That is how delivery actually works, and it
is the only reason a Bcc recipient shows up at all.
