<?php

declare(strict_types=1);

namespace Msgpit\Tests\Unit;

use Msgpit\Core\LinkChecker;
use Msgpit\Mime\Links;
use PHPUnit\Framework\TestCase;

final class LinksTest extends TestCase
{
    /** @return list<string> */
    private function urls(?string $html, ?string $text = null): array
    {
        return array_column(Links::find($html, $text), 'url');
    }

    public function testItFindsAnchors(): void
    {
        $urls = $this->urls('<p><a href="https://example.test/een">Een</a> <a href="https://example.test/twee">Twee</a></p>');

        self::assertSame(['https://example.test/een', 'https://example.test/twee'], $urls);
    }

    /** A client fetches these on its own, which is worth knowing separately from a click. */
    public function testItSeparatesResourcesFromClickableLinks(): void
    {
        $links = Links::find('<a href="https://example.test/klik">x</a><img src="https://example.test/pixel.gif">', null);

        self::assertSame('link', $links[0]['kind']);
        self::assertSame('resource', $links[1]['kind']);
    }

    public function testItFindsUrlsInCssBackgrounds(): void
    {
        $urls = $this->urls('<div style="background: url(https://example.test/bg.png) no-repeat">x</div>');

        self::assertSame(['https://example.test/bg.png'], $urls);
    }

    public function testItFindsUrlsInAStyleElement(): void
    {
        $urls = $this->urls('<style>.a { background-image: url("https://example.test/in-style.png"); }</style>');

        self::assertSame(['https://example.test/in-style.png'], $urls);
    }

    public function testItFindsUrlsInThePlainTextBody(): void
    {
        $urls = $this->urls(null, "Kijk op https://example.test/tekst voor meer.");

        self::assertSame(['https://example.test/tekst'], $urls);
    }

    /** Most clients turn a bare url in the body into a link, so it counts as one. */
    public function testABareUrlInTheHtmlTextIsALinkToo(): void
    {
        $links = Links::find('<p>Ga naar https://example.test/kaal</p>', null);

        self::assertSame([['url' => 'https://example.test/kaal', 'kind' => 'link']], $links);
    }

    public function testTrailingPunctuationIsNotPartOfTheUrl(): void
    {
        self::assertSame(['https://example.test/pad'], $this->urls(null, 'Zie https://example.test/pad.'));
        self::assertSame(['https://example.test/pad'], $this->urls(null, 'Zie https://example.test/pad, en meer'));
    }

    public function testTheSameUrlIsListedOnce(): void
    {
        $urls = $this->urls(
            '<a href="https://example.test/x">een</a><a href="https://example.test/x">twee</a>',
            'en ook https://example.test/x',
        );

        self::assertSame(['https://example.test/x'], $urls);
    }

    /** Clickable wins: that is the one a person can actually break. */
    public function testAUrlThatIsBothAResourceAndALinkCountsAsALink(): void
    {
        $links = Links::find('<img src="https://example.test/x.png"><a href="https://example.test/x.png">x</a>', null);

        self::assertCount(1, $links);
        self::assertSame('link', $links[0]['kind']);
    }

    /** Nothing a browser would fetch over the network. */
    public function testItIgnoresEverythingThatIsNotHttp(): void
    {
        $urls = $this->urls(
            '<a href="mailto:a@example.test">mail</a>'
            . '<a href="tel:+31612345678">bel</a>'
            . '<a href="#anchor">anker</a>'
            . '<img src="cid:logo">'
            . '<img src="data:image/png;base64,AAAA">',
            null,
        );

        self::assertSame([], $urls);
    }

    public function testEntitiesInAUrlAreDecoded(): void
    {
        $urls = $this->urls('<a href="https://example.test/?a=1&amp;b=2">x</a>');

        self::assertSame(['https://example.test/?a=1&b=2'], $urls);
    }

    public function testAMessageWithoutLinksHasNone(): void
    {
        self::assertSame([], Links::find('<p>Geen links hier.</p>', 'Ook niet.'));
        self::assertSame([], Links::find(null, null));
    }

    /** Never automatic: a link in mail can carry a token that is spent by fetching it. */
    public function testAnUnreachableHostIsReportedRatherThanThrowing(): void
    {
        $results = (new LinkChecker(timeout: 1))->check([
            ['url' => 'http://127.0.0.1:1/niets', 'kind' => 'link'],
        ]);

        self::assertCount(1, $results);
        self::assertNull($results[0]['status']);
        self::assertSame('Could not connect', $results[0]['reason']);
    }

    public function testItStopsAtItsLimit(): void
    {
        $links = [];

        for ($i = 0; $i < 10; $i++) {
            $links[] = ['url' => "http://127.0.0.1:1/{$i}", 'kind' => 'link'];
        }

        $results = (new LinkChecker(timeout: 1, maxLinks: 3))->check($links);

        self::assertCount(3, $results, 'A message with hundreds of links should not hang the request');
    }

    public function testCheckingNothingIsNotAnError(): void
    {
        self::assertSame([], (new LinkChecker())->check([]));
    }
}
