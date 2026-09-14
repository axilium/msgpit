<?php

declare(strict_types=1);

namespace Msgpit\Core;

/**
 * Checks whether the links in a message actually lead anywhere.
 *
 * This is the one thing msgpit does that reaches outside the development network, and it only
 * ever happens when someone presses the button. That is not caution for its own sake: links in
 * mail carry one-shot tokens. Fetching a password reset or an unsubscribe link can spend it, and
 * a tracking pixel counts the fetch as somebody reading the mail. So it is never automatic, never
 * on capture, and never on opening a message.
 *
 * HEAD is used where the server allows it, which asks for the headers without the body.
 */
final readonly class LinkChecker
{
    public function __construct(
        private int $timeout = 8,
        private int $maxLinks = 50,
    ) {}

    /**
     * @param list<array{url: string, kind: string}> $links
     * @return list<array{url: string, kind: string, status: ?int, reason: ?string, redirect: ?string}>
     */
    public function check(array $links): array
    {
        $results = [];

        foreach (array_slice($links, 0, $this->maxLinks) as $link) {
            $results[] = $link + $this->probe($link['url']);
        }

        return $results;
    }

    /**
     * Link-local addresses, which is where cloud metadata services live: 169.254.169.254 and
     * friends hand out credentials to anything that asks. No mail has a legitimate reason to
     * point there, so it is refused even though the rest of the private network is allowed.
     */
    private const REFUSED_HOSTS = [
        '/^169\.254\./',
        '/^\[?fe80:/i',
        '/^\[?fd00:ec2::254\]?$/i',
        '/^metadata\.google\.internal$/i',
    ];

    /** @return array{status: ?int, reason: ?string, redirect: ?string} */
    private function probe(string $url): array
    {
        $host = parse_url($url, PHP_URL_HOST);

        // Everything else on the private network is fair game: checking that a template built the
        // right url for http://web is one of the reasons this exists at all.
        if (is_string($host) && self::isRefused($host)) {
            return ['status' => null, 'reason' => 'Refused: link-local address', 'redirect' => null];
        }

        $result = $this->request($url, 'HEAD');

        // Plenty of servers refuse HEAD but answer GET perfectly well.
        if (in_array($result['status'], [405, 501], true) || $result['status'] === null) {
            $fallback = $this->request($url, 'GET');

            if ($fallback['status'] !== null) {
                return $fallback;
            }
        }

        return $result;
    }

    /** @return array{status: ?int, reason: ?string, redirect: ?string} */
    private function request(string $url, string $method): array
    {
        $context = stream_context_create([
            'http' => [
                'method' => $method,
                'timeout' => $this->timeout,
                'ignore_errors' => true,
                // Reported rather than followed: a redirect chain is something you want to see.
                'follow_location' => 0,
                'header' => "User-Agent: msgpit link check\r\nAccept: */*\r\n",
            ],
            'ssl' => [
                // A development machine rarely trusts every certificate it meets, and a
                // certificate problem is not what this check is about.
                'verify_peer' => false,
                'verify_peer_name' => false,
            ],
        ]);

        $handle = @fopen($url, 'r', false, $context);

        if ($handle === false) {
            return ['status' => null, 'reason' => 'Could not connect', 'redirect' => null];
        }

        /** @var array<string, mixed> $meta */
        $meta = stream_get_meta_data($handle);
        fclose($handle);

        /** @var list<string> $headers */
        $headers = is_array($meta['wrapper_data'] ?? null) ? array_values(array_filter($meta['wrapper_data'], 'is_string')) : [];

        return [
            'status' => self::status($headers),
            'reason' => null,
            'redirect' => self::header($headers, 'location'),
        ];
    }

    private static function isRefused(string $host): bool
    {
        foreach (self::REFUSED_HOSTS as $pattern) {
            if (preg_match($pattern, $host) === 1) {
                return true;
            }
        }

        return false;
    }

    /** @param list<string> $headers */
    private static function status(array $headers): ?int
    {
        foreach ($headers as $header) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $header, $matches) === 1) {
                // The last status line wins, in case the stream followed something after all.
                $status = (int) $matches[1];
            }
        }

        return $status ?? null;
    }

    /** @param list<string> $headers */
    private static function header(array $headers, string $name): ?string
    {
        foreach ($headers as $header) {
            if (stripos($header, $name . ':') === 0) {
                return trim(substr($header, strlen($name) + 1));
            }
        }

        return null;
    }
}
