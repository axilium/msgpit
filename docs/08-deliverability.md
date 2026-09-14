# Deliverability

Every captured mail gets a report: what a receiving server is likely to hold against it, scored out
of ten. It is the tab called **Deliverability**, and it sits last because it draws on all the others.

## What the score means

Ten points, minus what each finding costs. A finding is one of four things:

| | |
|---|---|
| ok | nothing to do |
| could be better | costs points, but no filter rejects a message over it alone |
| problem | costs real points and is worth fixing |
| not applicable | listed, explained, and left out of the sum |

That last one is the rule that makes the number usable. A mail msgpit caught itself never travelled:
no server saw it, so there is no SPF result, no signature and no bounce address. Counting those as
failures would mark down every test message for something it cannot have, and the score would stop
meaning anything. So they are skipped, and the tab says how many.

**It is not a prediction.** A real filter weighs the sending domain's reputation, how much mail it
usually sends, and whether people mark it as spam. None of that is visible from one message on a
development machine. The report tells you what is wrong *with the message*; it cannot tell you where
it will land.

## What is checked

**Spam filters.** The SpamAssassin score and the rules that produced it, which is the single
heaviest item: a message SpamAssassin dislikes is not rescued by anything further down.

**Authentication.** For an imported `.eml`, what the receiving server recorded in
`Authentication-Results` and `Received-SPF`: SPF, DKIM and DMARC. Reported rather than recomputed.
The server that wrote those headers had the sending IP in front of it and the key as it was at that
moment; a file on disk has neither, and an exported `.eml` is rarely byte-identical to what was
signed. Verifying it again here would fail messages that were accepted.

**Message content.** A text version beside the html and the other way around; elements clients strip
(`script`, `iframe`, `embed`, `object`, `form`); images without alt text, which is what the message
says while images are still blocked; the size against Gmail's clipping point of about 102 kB, past
which the footer is behind a link; the caniemail verdict; whether every body declares a character
set and holds what it declares; attachment types gateways refuse.

**Headers.** `From`, `To`, `Subject`, `Date` and `Message-ID`, whose absence is the mark of a message
assembled by a script. A display name on the sender. A `Return-Path` on the same domain as `From`,
because DMARC passes on alignment and a bounce address elsewhere is the usual way that quietly stops
being true. `List-Unsubscribe` together with `List-Unsubscribe-Post`, which Gmail and Yahoo require
from bulk senders and which transactional mail needs neither of.

**Links.** Anchor text that names one domain while the link opens another, which is the shape of a
phishing message whatever the reason for it here. Url shorteners, which hide the destination.

## Evidence

Every finding can be expanded to the thing it was based on: the SpamAssassin rules with their points,
the header that was read, the images without alt, the links that disagree with their own text. The
verdict is an opinion; the evidence is a fact, and only the second tells you where to look.
