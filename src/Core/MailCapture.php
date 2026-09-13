<?php

declare(strict_types=1);

namespace Msgpit\Core;

use Msgpit\Mime\ParsedMessage;
use Msgpit\Mime\Parser;
use Msgpit\Smtp\Envelope;

/**
 * Turns an accepted SMTP envelope into stored messages.
 *
 * One message per recipient, as everywhere else in msgpit: a mail to three people is three rows
 * sharing a batchId. The envelope decides who they are, not the To header, because that is how
 * delivery actually works and it is the only way a Bcc shows up at all.
 */
final readonly class MailCapture
{
    public function __construct(
        private Storage $storage,
        private ?SpamAssassin $spamAssassin = null,
    ) {}

    public function capture(Envelope $envelope): void
    {
        $parsed = Parser::parse($envelope->data);
        $batchId = Uuid::v4();
        $messages = [];

        // Best effort: a spamd that is down must not cost us the message.
        $spam = $this->spamAssassin?->check($envelope->data);

        foreach ($envelope->recipients as $recipient) {
            $messages[] = Message::create(
                batchId: $batchId,
                provider: 'smtp',
                channel: Channel::Email,
                to: $recipient,
                body: $parsed->preview(),
                from: $parsed->from !== '' ? $parsed->from : $envelope->sender,
                providerRef: $parsed->headers['message-id'] ?? null,
                meta: self::meta($parsed, $envelope, $spam),
            );
        }

        if ($messages === []) {
            return;
        }

        $this->storage->storeMail($messages, $parsed);
    }

    /** @return array<string, mixed> */
    private static function meta(ParsedMessage $parsed, Envelope $envelope, ?SpamReport $spam): array
    {
        $meta = [
            'subject' => $parsed->subject,
            'envelopeSender' => $envelope->sender,
            'envelopeRecipients' => $envelope->recipients,
            'to' => $parsed->headers['to'] ?? null,
            'cc' => $parsed->headers['cc'] ?? null,
            'replyTo' => $parsed->headers['reply-to'] ?? null,
            'date' => $parsed->headers['date'] ?? null,
            'hasHtml' => $parsed->html() !== null,
            'attachments' => count($parsed->attachments()),
            'spam' => $spam?->toArray(),
        ];

        return array_filter($meta, static fn (mixed $value): bool => $value !== null && $value !== []);
    }
}
