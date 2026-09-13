import {renderMarkdown} from '/ui/markdown.js';

const FALLBACK_POLL_MS = 2000;
const SEGMENT_LIMITS = {'GSM-7': {single: 160, concatenated: 153}, 'UCS-2': {single: 70, concatenated: 67}};

const el = {
    messages: document.getElementById('messages'),
    empty: document.getElementById('empty'),
    detail: document.getElementById('detail'),
    search: document.getElementById('search'),
    scenario: document.getElementById('scenario'),
    clear: document.getElementById('clear'),
    markRead: document.getElementById('mark-read'),
    notify: document.getElementById('notify'),
    navAll: document.getElementById('nav-all'),
    navProviders: document.getElementById('nav-providers'),
    navChannels: document.getElementById('nav-channels'),
    navDocs: document.getElementById('nav-docs'),
    docsToggle: document.getElementById('docs-toggle'),
    docs: document.getElementById('docs'),
    workspace: document.querySelector('.workspace'),
    statMessages: document.getElementById('stat-messages'),
    statSegments: document.getElementById('stat-segments'),
    statRecipients: document.getElementById('stat-recipients'),
    connection: document.getElementById('connection'),
    version: document.getElementById('version'),
};

const state = {
    messages: [],
    selectedId: null,
    tab: ['message', 'raw', 'delivery', 'meta'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'message',
    filter: {provider: '', channel: ''},
    search: '',
    signature: '',
    touched: false,
    doc: null,
    scenarios: [],
    unread: 0,
    dlrProviders: [],
};

const api = async (path, options = {}) => {
    const response = await fetch(`/api${path}`, {headers: {'Content-Type': 'application/json'}, ...options});

    if (!response.ok) {
        throw new Error(`${options.method ?? 'GET'} /api${path} failed: ${response.status}`);
    }

    return response.status === 204 ? null : response.json();
};

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => (
    {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]
));

// Text context only, so quotes survive for the JSON highlighter to key on.
const escapeText = (value) => String(value ?? '').replace(/[&<>]/g, (char) => (
    {'&': '&amp;', '<': '&lt;', '>': '&gt;'}[char]
));

const formatTime = (iso) => new Date(iso).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'});

const formatDateTime = (iso) => new Date(iso).toLocaleString([], {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** Mirrors Core\Segments: one character outside GSM-7 pushes the whole message to UCS-2. */
const highlightBody = (body, ucs2Offsets = []) => {
    const offsets = new Set(ucs2Offsets);

    return [...body]
        .map((char, index) => (offsets.has(index)
            ? `<mark class="ucs2" title="Forces UCS-2 encoding">${escapeHtml(char)}</mark>`
            : escapeHtml(char)))
        .join('');
};

/** One bar per segment, each filled to how much of its capacity is used. */
const renderMeter = (message) => {
    const limits = SEGMENT_LIMITS[message.encoding];

    if (!limits || !message.segments) {
        return '';
    }

    const capacity = message.segments === 1 ? limits.single : limits.concatenated;
    const total = message.segments * capacity;
    const ucs2 = message.encoding === 'UCS-2';

    const parts = Array.from({length: message.segments}, (unused, index) => {
        const used = Math.max(0, Math.min(capacity, message.units - index * capacity));

        return `<span class="meter-part${ucs2 ? ' ucs2' : ''}">
            <span class="meter-fill" style="width: ${(used / capacity) * 100}%"></span>
        </span>`;
    }).join('');

    return `
        <div class="meter">${parts}</div>
        <p class="meter-caption">
            ${escapeHtml(message.encoding)} &middot; ${plural(message.segments, 'segment')} &middot;
            ${message.units} of ${total} ${ucs2 ? 'code units' : 'septets'} used &middot;
            ${plural(message.characters, 'character')}
        </p>
    `;
};

/** Colours an already escaped JSON string; keys and values get their own token class. */
const highlightJson = (json) => json.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
        if (/^"/.test(match)) {
            return `<span class="tok-${/:$/.test(match) ? 'key' : 'string'}">${match}</span>`;
        }

        return `<span class="tok-${/true|false|null/.test(match) ? 'literal' : 'number'}">${match}</span>`;
    },
);

/** Splits the stored request into headers and body, pretty-printing the body when it is JSON. */
const renderRaw = (rawRequest) => {
    const separator = rawRequest.indexOf('\n\n');
    const head = separator === -1 ? rawRequest : rawRequest.slice(0, separator);
    const body = separator === -1 ? '' : rawRequest.slice(separator + 2);

    if (body.trim() === '') {
        return `<pre>${escapeHtml(head)}</pre>`;
    }

    try {
        const formatted = JSON.stringify(JSON.parse(body), null, 2);

        return `<pre>${escapeHtml(head)}\n\n<span class="json">${highlightJson(escapeText(formatted))}</span></pre>`;
    } catch {
        // Not JSON (form encoded, XML, whatever the provider takes): show it untouched.
        return `<pre>${escapeHtml(rawRequest)}</pre>`;
    }
};

/** Pretty-prints a standalone JSON string, leaving anything else alone. */
const formatJson = (value) => {
    try {
        return highlightJson(escapeText(JSON.stringify(JSON.parse(value), null, 2)));
    } catch {
        return escapeHtml(value);
    }
};

const visibleMessages = () => state.messages.filter((message) => {
    if (state.filter.provider && message.provider !== state.filter.provider) {
        return false;
    }

    if (state.filter.channel && message.channel !== state.filter.channel) {
        return false;
    }

    const needle = state.search.toLowerCase();

    return needle === ''
        || message.to.toLowerCase().includes(needle)
        || message.body.toLowerCase().includes(needle);
});

const renderSidebar = () => {
    const countBy = (key) => state.messages.reduce((totals, message) => (
        {...totals, [message[key]]: (totals[message[key]] ?? 0) + 1}
    ), {});

    const item = (label, count, type, value) => `
        <li>
            <button type="button" data-filter="${type}" data-value="${escapeHtml(value)}"
                    aria-current="${state.filter[type] === value}">
                <span>${escapeHtml(label)}</span>
                <span class="count">${count}</span>
            </button>
        </li>
    `;

    el.navAll.innerHTML = `
        <li>
            <button type="button" data-filter="all" data-value=""
                    aria-current="${!state.filter.provider && !state.filter.channel}">
                <span>All messages</span>
                <span class="count">
                    ${state.unread > 0 ? `<span class="unread-count">${state.unread}</span>` : ''}
                    ${state.messages.length}
                </span>
            </button>
        </li>
    `;

    const providers = countBy('provider');
    const channels = countBy('channel');

    el.navProviders.innerHTML = Object.entries(providers)
        .map(([name, count]) => item(name, count, 'provider', name))
        .join('') || '<li><button type="button" disabled><span>None yet</span></button></li>';

    el.navChannels.innerHTML = Object.entries(channels)
        .map(([name, count]) => item(name, count, 'channel', name))
        .join('') || '<li><button type="button" disabled><span>None yet</span></button></li>';
};

/** The unread count belongs in the title too: the tab is often the only thing you can see. */
const renderTitle = () => {
    document.title = state.unread > 0 ? `(${state.unread}) msgpit` : 'msgpit';
};

const renderStats = () => {
    const messages = visibleMessages();
    const segments = messages.reduce((total, message) => total + (message.segments ?? 0), 0);
    const recipients = new Set(messages.map((message) => message.to)).size;

    renderTitle();
    el.statMessages.textContent = plural(messages.length, 'message');
    el.statSegments.textContent = plural(segments, 'segment');
    el.statRecipients.textContent = plural(recipients, 'recipient');
};

const renderList = () => {
    const messages = visibleMessages();

    el.empty.hidden = messages.length > 0;

    el.messages.innerHTML = messages.map((message) => `
        <li data-id="${escapeHtml(message.id)}" aria-selected="${message.id === state.selectedId}"
            class="${message.read ? '' : 'unread'}">
            <div class="list-head">
                <span class="to">${escapeHtml(message.to)}</span>
                <time datetime="${escapeHtml(message.createdAt)}">${formatTime(message.createdAt)}</time>
            </div>
            <p class="preview">${escapeHtml(message.body) || '<em>empty</em>'}</p>
            <div class="tags">
                <span class="tag">${escapeHtml(message.provider)}</span>
                <span class="tag">${escapeHtml(message.channel)}</span>
                ${message.segments ? `<span class="tag${message.encoding === 'UCS-2' ? ' encoding-ucs2' : ''}">${escapeHtml(message.encoding)} &middot; ${message.segments}</span>` : ''}
                <span class="tag status-${escapeHtml(message.status)}">${escapeHtml(message.status)}</span>
            </div>
        </li>
    `).join('');
};

const panels = {
    message: (message) => `
        <h3>Body</h3>
        <p class="body-text">${highlightBody(message.body, message.ucs2Offsets) || '<em>empty</em>'}</p>
        ${message.segments ? `<h3>Segments</h3>${renderMeter(message)}` : ''}
        <h3>Routing</h3>
        <dl class="fields">
            <dt>From</dt><dd>${escapeHtml(message.from ?? '-')}</dd>
            <dt>To</dt><dd>${escapeHtml(message.to)}</dd>
            <dt>Provider reference</dt><dd>${escapeHtml(message.providerRef ?? '-')}</dd>
            <dt>Batch</dt><dd>${escapeHtml(message.batchId)}</dd>
            <dt>Captured</dt><dd>${formatDateTime(message.createdAt)}</dd>
        </dl>
    `,

    raw: (message) => `
        <h3>Request as received</h3>
        ${renderRaw(message.rawRequest ?? '')}
    `,

    delivery: (message) => `
        <h3>Report back to the app</h3>
        <div class="dlr-actions">
            <button type="button" class="primary" data-dlr="delivered">Mark delivered</button>
            <button type="button" class="ghost danger" data-dlr="failed">Mark failed</button>
        </div>
        ${message.deliveryReports.length === 0
            ? '<p class="empty">No delivery reports sent yet. Set MSGPIT_SPRYNG_DLR_URL to have msgpit call your app back.</p>'
            : message.deliveryReports.map((report) => `
                <div class="report">
                    <div class="report-head">
                        <span class="tag status-${escapeHtml(report.status)}">${escapeHtml(report.status)}</span>
                        <span class="url" title="${escapeHtml(report.url)}">${escapeHtml(report.url)}</span>
                        <span>${report.responseStatus ?? 'no response'} &middot; ${formatTime(report.sentAt)}</span>
                    </div>
                    <pre>${formatJson(report.responseBody ?? '')}</pre>
                </div>
            `).join('')}
    `,

    meta: (message) => `
        <h3>Provider extras</h3>
        ${Object.keys(message.meta).length === 0
            ? '<p class="empty">This request carried no extra fields.</p>'
            : `<pre>${escapeHtml(JSON.stringify(message.meta, null, 2))}</pre>`}
    `,
};

/** Delivery only makes sense for providers that can call the app back, so e-mail never gets the tab. */
const tabsFor = (message) => {
    const tabs = [
        ['message', 'Message', null],
        ['raw', 'Raw', null],
    ];

    if (state.dlrProviders.includes(message.provider)) {
        tabs.push(['delivery', 'Delivery', message.deliveryReports.length || null]);
    }

    tabs.push(['meta', 'Meta', Object.keys(message.meta).length || null]);

    return tabs;
};

const renderDetail = (message) => {
    const tabs = tabsFor(message);

    // A deep link or a previous message can point at a tab this message does not have.
    if (!tabs.some(([id]) => id === state.tab)) {
        state.tab = 'message';
    }

    el.detail.innerHTML = `
        <div class="detail-head">
            <h2>${escapeHtml(message.to)}</h2>
            <p class="subtitle">
                ${escapeHtml(message.provider)} &middot; ${escapeHtml(message.channel)} &middot;
                ${formatDateTime(message.createdAt)} &middot; ${escapeHtml(message.status)}
            </p>
        </div>
        <div class="tabs" role="tablist">
            ${tabs.map(([id, label, count]) => `
                <button type="button" role="tab" data-tab="${id}" aria-selected="${state.tab === id}">
                    ${label}${count ? `<span class="count">${count}</span>` : ''}
                </button>
            `).join('')}
        </div>
        <div class="panel" role="tabpanel">${panels[state.tab](message)}</div>
    `;

    el.detail.querySelectorAll('[data-tab]').forEach((button) => {
        button.addEventListener('click', () => {
            state.tab = button.dataset.tab;
            history.replaceState(null, '', `#${state.tab}`);
            renderDetail(message);
        });
    });

    el.detail.querySelectorAll('[data-dlr]').forEach((button) => {
        button.addEventListener('click', async () => {
            button.disabled = true;
            await api(`/messages/${message.id}/dlr`, {
                method: 'POST',
                body: JSON.stringify({status: button.dataset.dlr}),
            });
            await openMessage(message.id);
        });
    });
};

const clearDetail = () => {
    state.selectedId = null;
    el.detail.innerHTML = '<p class="empty">Select a message to inspect it.</p>';
};

const openMessage = async (id) => {
    state.selectedId = id;

    const message = await api(`/messages/${id}`);

    renderDetail(message);

    if (!message.read) {
        const {unread} = await api(`/messages/${id}/read`, {method: 'POST'});

        state.unread = unread;
        state.signature = '';
        await refresh();
    }

    el.messages.querySelectorAll('li').forEach((item) => {
        item.setAttribute('aria-selected', String(item.dataset.id === id));
    });
};

const refresh = async () => {
    const {messages, unread} = await api('/messages');

    state.messages = messages;
    state.unread = unread;
    el.markRead.hidden = unread === 0;

    // Only rebuild the list when something changed, so polling does not fight with scrolling.
    const signature = messages.map((message) => `${message.id}:${message.status}:${message.read}`).join(',')
        + `|${state.filter.provider}|${state.filter.channel}|${state.search}`;

    if (signature !== state.signature) {
        state.signature = signature;
        renderList();
        renderSidebar();
    }

    renderStats();

    if (state.selectedId && !messages.some((message) => message.id === state.selectedId)) {
        clearDetail();
    }

    // Open the newest message on first load, so the pane is never pointlessly empty.
    if (state.selectedId === null && messages.length > 0 && !state.touched) {
        state.touched = true;
        await openMessage(messages[0].id);
    }
};

const loadProviders = async () => {
    const {providers, version} = await api('/providers');

    state.dlrProviders = providers.filter((provider) => provider.deliveryReports).map((provider) => provider.id);

    // Only a real release gets the v prefix; "dev" and "dev-<sha>" stand on their own.
    el.version.textContent = /^\d/.test(version) ? `v${version}` : version;

    // Providers with no messages yet should still be visible in the sidebar.
    if (providers.length > 0 && state.messages.length === 0) {
        el.navProviders.innerHTML = providers.map((provider) => `
            <li><button type="button" data-filter="provider" data-value="${escapeHtml(provider.id)}"
                        aria-current="false"><span>${escapeHtml(provider.id)}</span>
                <span class="count">0</span></button></li>
        `).join('');
    }
};


/** The scenario table is rendered from the API, so the docs cannot drift from the code. */
const scenarioTable = () => {
    if (state.scenarios.length === 0) {
        return '';
    }

    const rows = state.scenarios
        .filter((scenario) => scenario.recipient)
        .map((scenario) => `
            <tr>
                <td><code>${escapeHtml(scenario.recipient)}</code></td>
                <td>${escapeHtml(scenario.scenario)}</td>
                <td>${escapeHtml(scenario.description)}</td>
            </tr>
        `).join('');

    return `<div class="table-scroll"><table>
        <thead><tr><th>Recipient</th><th>Scenario</th><th>What your app sees</th></tr></thead>
        <tbody>${rows}</tbody>
    </table></div>`;
};

const closeDocsMenu = () => {
    el.navDocs.hidden = true;
    el.docsToggle.setAttribute('aria-expanded', 'false');
};

const toggleDocsMenu = () => {
    const opening = el.navDocs.hidden;

    el.navDocs.hidden = !opening;
    el.docsToggle.setAttribute('aria-expanded', String(opening));
};

const openDoc = async (slug) => {
    const {markdown} = await api(`/docs/${slug}`);

    state.doc = slug;
    closeDocsMenu();
    el.workspace.classList.add('reading');
    el.docs.hidden = false;
    el.docs.innerHTML = renderMarkdown(markdown, {scenarios: scenarioTable()});
    el.docs.scrollTop = 0;

    el.navDocs.querySelectorAll('button').forEach((button) => {
        button.setAttribute('aria-current', String(button.dataset.doc === slug));
    });

    history.replaceState(null, '', `#docs/${slug}`);
};

const closeDocs = () => {
    state.doc = null;
    el.workspace.classList.remove('reading');
    el.docs.hidden = true;
    el.navDocs.querySelectorAll('button').forEach((button) => button.setAttribute('aria-current', 'false'));
};

const loadDocs = async () => {
    const [{pages}, {scenarios}] = await Promise.all([api('/docs'), api('/scenarios')]);

    state.scenarios = scenarios;
    el.navDocs.innerHTML = pages.map((page) => `
        <li role="none">
            <button type="button" role="menuitem" data-doc="${escapeHtml(page.slug)}" aria-current="false">
                ${escapeHtml(page.title)}
            </button>
        </li>
    `).join('');
};


/**
 * Desktop notifications for captured messages.
 *
 * The Notifications API needs a secure context, and Docksal serves projects over plain http by
 * default, so the button explains that rather than silently doing nothing. Over https it works,
 * including with Docksal's self-signed certificate once you accept it.
 */
const notifications = {
    key: 'msgpit.notifications',
    queue: [],
    timer: null,

    get available() {
        return 'Notification' in window && window.isSecureContext;
    },

    get permission() {
        return this.available ? Notification.permission : 'unsupported';
    },

    get wanted() {
        try {
            return localStorage.getItem(this.key) === 'on';
        } catch {
            return false;
        }
    },

    set wanted(value) {
        try {
            localStorage.setItem(this.key, value ? 'on' : 'off');
        } catch {
            // A private window refuses storage; the choice then lasts for this page only.
        }
    },

    get active() {
        return this.available && this.permission === 'granted' && this.wanted;
    },

    render() {
        const button = el.notify;

        button.setAttribute('aria-pressed', String(this.active));

        if (!this.available) {
            button.dataset.state = 'unavailable';
            button.title = 'Desktop notifications need https. Click to reopen this page securely.';

            return;
        }

        if (this.permission === 'denied') {
            button.dataset.state = 'unavailable';
            button.title = 'Your browser is blocking notifications for this site.';

            return;
        }

        button.dataset.state = this.active ? 'on' : 'off';
        button.title = this.active ? 'Desktop notifications are on' : 'Turn on desktop notifications';
    },

    async toggle() {
        if (!this.available) {
            // http cannot ask for permission at all, so send the user somewhere that can.
            if (location.protocol === 'http:') {
                location.href = `https://${location.host}${location.pathname}${location.hash}`;
            }

            return;
        }

        if (this.permission === 'denied') {
            return;
        }

        if (this.permission === 'default') {
            this.wanted = await Notification.requestPermission() === 'granted';
            this.render();

            return;
        }

        this.wanted = !this.wanted;
        this.render();
    },

    /** Collected briefly, so one request to fifty recipients is one notification and not fifty. */
    queueMessage(message) {
        if (!this.active || !document.hidden) {
            return;
        }

        this.queue.push(message);
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), 400);
    },

    flush() {
        const queued = this.queue.splice(0);

        if (queued.length === 0) {
            return;
        }

        const single = queued.length === 1 ? queued[0] : null;
        const notification = new Notification(
            single ? `${single.provider} to ${single.to}` : `${queued.length} new messages`,
            {
                body: single ? single.body : queued.map((message) => message.to).join(', '),
                tag: 'msgpit',
                icon: document.querySelector('link[rel="icon"]')?.href,
            },
        );

        notification.onclick = () => {
            window.focus();
            notification.close();

            if (single) {
                state.touched = true;
                closeDocs();
                openMessage(single.id);
            }
        };
    },
};

const setConnection = (label, className) => {
    el.connection.textContent = label;
    el.connection.className = `connection ${className}`;
};

document.querySelector('.sidebar').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');

    if (!button) {
        return;
    }

    closeDocs();

    if (button.dataset.filter === 'all') {
        state.filter = {provider: '', channel: ''};
    } else {
        const type = button.dataset.filter;
        state.filter = {...state.filter, [type]: state.filter[type] === button.dataset.value ? '' : button.dataset.value};
    }

    state.signature = '';
    refresh();
});

el.docsToggle.addEventListener('click', () => toggleDocsMenu());

el.navDocs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-doc]');

    if (button) {
        openDoc(button.dataset.doc);
    }
});

// Anywhere outside the menu closes it, Escape included.
document.addEventListener('click', (event) => {
    if (!event.target.closest('.menu')) {
        closeDocsMenu();
    }
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !el.navDocs.hidden) {
        closeDocsMenu();
        el.docsToggle.focus();
    }
});

el.messages.addEventListener('click', (event) => {
    const item = event.target.closest('li');

    if (item) {
        state.touched = true;
        closeDocs();
        openMessage(item.dataset.id);
    }
});

el.docs.addEventListener('click', (event) => {
    const link = event.target.closest('a[href^="#docs/"]');

    if (link) {
        event.preventDefault();
        openDoc(link.getAttribute('href').slice('#docs/'.length));
    }
});

el.search.addEventListener('input', () => {
    state.search = el.search.value.trim();
    state.signature = '';
    refresh();
});

el.scenario.addEventListener('change', () => api('/scenario', {
    method: 'POST',
    body: JSON.stringify({scenario: el.scenario.value || null}),
}));

el.notify.addEventListener('click', () => notifications.toggle());

el.markRead.addEventListener('click', async () => {
    await api('/messages/read', {method: 'POST'});
    state.signature = '';
    await refresh();
});

el.clear.addEventListener('click', async () => {
    await api('/messages', {method: 'DELETE'});
    clearDetail();
    state.signature = '';
    await refresh();
});

// SSE is the live path; polling only takes over while the stream is down.
let fallbackTimer = null;
let lastSeq = 0;

const connect = () => {
    const stream = new EventSource(`/api/stream?seq=${lastSeq}`);

    stream.onopen = () => {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
        setConnection('Live', 'live');
    };

    stream.onmessage = (event) => {
        const payload = JSON.parse(event.data);
        lastSeq = payload.seq;
        state.signature = '';
        refresh();

        if (payload.type === 'message' && payload.message) {
            notifications.queueMessage(payload.message);
        }

        // A status change on the open message should update the pane, not just the list.
        if ((payload.type === 'status' || payload.type === 'read') && payload.message?.id === state.selectedId) {
            openMessage(state.selectedId);
        }
    };

    // EventSource reconnects by itself; polling bridges the gap.
    stream.onerror = () => {
        setConnection('Polling', 'polling');
        fallbackTimer ??= setInterval(refresh, FALLBACK_POLL_MS);
    };
};

await loadProviders();
await refresh();
await loadDocs();
notifications.render();

// Deep link straight into a reference page.
if (location.hash.startsWith('#docs/')) {
    await openDoc(location.hash.slice('#docs/'.length));
}

// Opened after load: a stream started during page load keeps the tab spinner running forever.
if (document.readyState === 'complete') {
    connect();
} else {
    window.addEventListener('load', () => setTimeout(connect, 0), {once: true});
}
