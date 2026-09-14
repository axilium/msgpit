/**
 * Lays out a raw email the way it is actually built: headers, boundaries, and the bodies in
 * between.
 *
 * A general syntax highlighter cannot help here, because the mess is not syntax. A message with
 * an attachment contains a single base64 line of fifteen thousand characters, and no colouring
 * makes that readable. Folding it away does.
 */

const BASE64_LINE = /^[A-Za-z0-9+/=]{40,}$/;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => (
    {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]
));

const formatBytes = (bytes) => (bytes < 1024
    ? `${bytes} B`
    : (bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} kB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`));

export const renderRawMessage = (raw) => {
    // Strip every carriage return, not only the pairs: a stray one ends up visible otherwise.
    const lines = raw.replace(/\r/g, '').split('\n');
    const out = [];

    let inHeaders = true;
    let sawHeader = false;
    let blob = [];

    const flushBlob = () => {
        if (blob.length === 0) {
            return;
        }

        const bytes = blob.join('').length;
        const preview = blob[0].slice(0, 48);

        out.push(`<details class="blob">
            <summary><span class="blob-preview">${escapeHtml(preview)}…</span>
            <span class="blob-size">${formatBytes(bytes)} base64</span></summary>
            <pre>${escapeHtml(blob.join('\n'))}</pre>
        </details>`);

        blob = [];
    };

    for (const line of lines) {
        // A boundary both separates parts and starts a new header block.
        if (/^--[^\s]+-*$/.test(line.trim()) && line.trim().length > 3) {
            flushBlob();
            out.push(`<div class="raw-boundary">${escapeHtml(line)}</div>`);
            inHeaders = true;
            sawHeader = false;

            continue;
        }

        if (BASE64_LINE.test(line.trim())) {
            blob.push(line.trim());

            continue;
        }

        flushBlob();

        if (line.trim() === '') {
            inHeaders = inHeaders && !sawHeader;
            out.push('<div class="raw-blank"></div>');

            continue;
        }

        const header = inHeaders ? line.match(/^([A-Za-z][A-Za-z0-9-]*):(.*)$/) : null;

        if (header) {
            sawHeader = true;
            out.push(`<div class="raw-line"><span class="raw-name">${escapeHtml(header[1])}:</span>${escapeHtml(header[2])}</div>`);

            continue;
        }

        out.push(`<div class="raw-line${inHeaders ? ' raw-folded' : ''}">${escapeHtml(line)}</div>`);
    }

    flushBlob();

    return `<div class="raw-message">${out.join('')}</div>`;
};
