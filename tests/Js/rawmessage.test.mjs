/**
 * Tests for the raw message view. The thing it has to get right is not colour but structure:
 * telling headers from bodies, marking boundaries, and folding away the base64 that makes a
 * message with an attachment unreadable.
 *
 * Run with: fin exec node tests/Js/rawmessage.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {renderRawMessage} from '../../public/ui/rawmessage.js';

const message = (body) => [
    'SMTP inbound HTTP/1.1',
    '',
    'From: InvalPool <info@invalpool.nl>',
    'To: raymond@example.test',
    'Subject: Aanstelling',
    'Content-Type: multipart/mixed; boundary="mix"',
    '',
    body,
].join('\n');

test('headers are marked as headers', () => {
    const html = renderRawMessage(message('tekst'));

    assert.match(html, /<span class="raw-name">From:<\/span>/);
    assert.match(html, /<span class="raw-name">Subject:<\/span>/);
});

/**
 * The envelope line sits above the message with a blank line after it. Treating that blank line
 * as the end of the headers would leave From and Subject looking like body text.
 */
test('the envelope line does not end the header block', () => {
    const html = renderRawMessage(message('tekst'));

    assert.match(html, /<span class="raw-name">To:<\/span>/, 'To comes after the envelope line');
});

test('boundaries are set apart', () => {
    const html = renderRawMessage(message('--mix\nContent-Type: text/plain\n\nhoi\n--mix--'));

    assert.match(html, /<div class="raw-boundary">--mix<\/div>/);
    assert.match(html, /<div class="raw-boundary">--mix--<\/div>/);
});

test('a boundary starts a new header block', () => {
    const html = renderRawMessage(message('--mix\nContent-Type: text/plain\n\nhoi'));

    assert.match(html, /<span class="raw-name">Content-Type:<\/span>/);
});

test('body text is not mistaken for headers', () => {
    const html = renderRawMessage(message('--mix\nContent-Type: text/plain\n\nBeste Jansen: tot ziens\n--mix--'));

    assert.doesNotMatch(html, /<span class="raw-name">Beste Jansen:<\/span>/, 'A colon in a sentence is not a header');
});

test('base64 is folded away with its size', () => {
    const blob = Array.from({length: 40}, () => 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w').join('\n');
    const html = renderRawMessage(message(`--mix\nContent-Transfer-Encoding: base64\n\n${blob}\n--mix--`));

    assert.match(html, /<details class="blob">/);
    assert.match(html, /kB base64<\/span>/, 'The size is what you want to know at a glance');
    assert.match(html, /class="blob-preview"/);
});

test('the folded content is still there, just closed', () => {
    const line = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w';
    const html = renderRawMessage(message(`--mix\n\n${line}\n${line}\n--mix--`));

    assert.match(html, new RegExp(line), 'Nothing is thrown away');
    assert.match(html, /<details/, 'but it starts collapsed');
});

test('one short base64-looking word is not a blob', () => {
    const html = renderRawMessage(message('Dit is gewone tekst met korte woorden.'));

    assert.doesNotMatch(html, /<details class="blob">/);
});

test('html is escaped', () => {
    const html = renderRawMessage(message('<script>alert(1)</script>'));

    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
});

test('an empty message does not explode', () => {
    assert.match(renderRawMessage(''), /<div class="raw-message">/);
});

test('crlf line endings are handled', () => {
    const crlf = message('--mix\nContent-Type: text/plain\n\nhoi').replace(/\n/g, '\r\n');
    const html = renderRawMessage(crlf);

    assert.match(html, /<div class="raw-boundary">--mix<\/div>/, 'A stray carriage return must not end up in the output');
    assert.match(html, /<span class="raw-name">From:<\/span>/);
});

test('every line of a real message ends up somewhere', () => {
    const html = renderRawMessage(message('--mix\nContent-Type: text/plain\n\nregel een\nregel twee\n--mix--'));

    for (const needle of ['regel een', 'regel twee', 'Content-Type', 'From']) {
        assert.match(html, new RegExp(needle), `${needle} is missing from the output`);
    }
});
