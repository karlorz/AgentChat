/**
 * Live READ-ONLY Muse doctor probe.
 *
 * Never types, never sends a prompt, never navigates an existing tab,
 * never calls Page.bringToFront / Target.activateTarget, never starts Chrome.
 * Respect AGENTCHAT_NO_AUTOSTART=1 — do not call ensureChromeCdp.
 *
 * probe(opts, deps) is injectable so tests can mock CDP/http/locks/proc/clock.
 */
'use strict';

const { forkSeat, KNOWN_BOX_SEATS } = require('../../scripts/lib/seat-census.cjs');
const { readSeatLock } = require('../lib/seatLock');

const DEFAULT_MUSE_PORT = 9227;
const DEFAULT_HOST = '127.0.0.1';
const POLL_MS = 1000;
const POLL_TIMEOUT_MS = 18_000;
const HTTP_TIMEOUT_MS = 2000;
const MUSE_HOME = 'https://muse.ai/';

const PUBLIC_KEYS = Object.freeze(['state', 'reason', 'seat', 'port', 'display', 'checked_at']);
const BLOCKED_REASONS = Object.freeze(['seat', 'busy', 'no_input', 'cdp_error']);

function loadMuseAdapter() {
    return require('../lib/providers/adapters/muse.js');
}

function expectedSeat(port) {
    const n = Number(port);
    if (n === 9222) return { seat: 'AgentChat', display: null };
    const known = KNOWN_BOX_SEATS.find(s => s.port === n);
    if (known) return { seat: known.seat, display: known.display || null };
    if (Number.isInteger(n) && n > 9222) {
        try {
            const s = forkSeat(n - 9222);
            return { seat: s.seat, display: s.display };
        } catch (_) { /* fall through */ }
    }
    return { seat: `cdp-${n}`, display: null };
}

function isLocalHost(host) {
    const h = String(host || '').toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0.0.0.0';
}

function normDisplay(d) {
    if (d == null || d === '') return null;
    const s = String(d).trim();
    const m = s.match(/:(\d+)/);
    if (m) return `:${m[1]}`;
    return s;
}

function publicResult(result) {
    return {
        state: result.state,
        reason: result.state === 'ready' ? null : (result.reason ?? null),
        seat: result.seat,
        port: result.port,
        display: result.display == null ? null : result.display,
        checked_at: result.checked_at,
    };
}

function exitCodeFor(state) {
    if (state === 'ready') return 0;
    if (state === 'needs_human') return 2;
    return 3;
}

function sleep(ms) {
    if (!ms || ms <= 0) return Promise.resolve();
    return new Promise(r => setTimeout(r, ms));
}

async function defaultGetJson(url, timeoutMs = HTTP_TIMEOUT_MS) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ac.signal });
        if (!res.ok) {
            const err = new Error(`HTTP ${res.status}`);
            err.code = 'HTTP_ERROR';
            throw err;
        }
        return await res.json();
    } finally {
        clearTimeout(t);
    }
}

function defaultWsConnect(url) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const ws = new WebSocket(url);
        const pending = new Map();
        let nextId = 1;
        const fail = (err) => {
            if (settled) return;
            settled = true;
            reject(err instanceof Error ? err : new Error(String(err)));
        };
        ws.addEventListener('open', () => {
            settled = true;
            resolve({
                send(method, params) {
                    return new Promise((res, rej) => {
                        const id = nextId++;
                        pending.set(id, { res, rej });
                        try {
                            ws.send(JSON.stringify({ id, method, params: params || {} }));
                        } catch (e) {
                            pending.delete(id);
                            rej(e);
                        }
                    });
                },
                close() {
                    try { ws.close(); } catch (_) {}
                },
            });
        });
        ws.addEventListener('message', (ev) => {
            let msg;
            try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); }
            catch (_) { return; }
            if (msg && msg.id != null && pending.has(msg.id)) {
                const { res, rej } = pending.get(msg.id);
                pending.delete(msg.id);
                if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
                else res(msg.result);
            }
        });
        ws.addEventListener('error', (ev) => fail((ev && ev.error) || new Error('WebSocket error')));
        ws.addEventListener('close', () => {
            for (const { rej } of pending.values()) rej(new Error('WebSocket closed'));
            pending.clear();
            fail(new Error('WebSocket closed'));
        });
    });
}

function defaultReadChromeDisplay(port) {
    const fs = require('fs');
    let entries;
    try {
        entries = fs.readdirSync('/proc');
    } catch (e) {
        return { error: e.message || 'no /proc' };
    }
    const re = new RegExp(`--remote-debugging-port[= ]${Number(port)}(?!\\d)`);
    for (const name of entries) {
        if (!/^\d+$/.test(name)) continue;
        let cmd;
        try {
            cmd = fs.readFileSync(`/proc/${name}/cmdline`);
        } catch (_) { continue; }
        const text = cmd.toString('utf8').replace(/\0/g, ' ');
        if (!re.test(text)) continue;
        let display = null;
        try {
            const envBuf = fs.readFileSync(`/proc/${name}/environ`);
            const parts = envBuf.toString('utf8').split('\0');
            const row = parts.find(p => p.startsWith('DISPLAY='));
            if (row) display = row.slice('DISPLAY='.length);
        } catch (e) {
            return { pid: Number(name), display: null, error: e.message };
        }
        return { pid: Number(name), display };
    }
    return { error: 'chrome not found' };
}

function musePageTarget(targets) {
    const list = Array.isArray(targets) ? targets : [];
    return list.find((t) => {
        if (!t || t.type !== 'page') return false;
        const url = String(t.url || '');
        try {
            const u = new URL(url);
            return u.hostname === 'muse.ai' || u.hostname.endsWith('.muse.ai');
        } catch (_) {
            return /muse\.ai/i.test(url);
        }
    }) || null;
}

function hrefMatchesAuth(href, authDomains) {
    const h = String(href || '');
    return (authDomains || []).some(d => d && h.includes(d));
}

function plainCssSelectors(signedOutSelectors) {
    return (signedOutSelectors || []).filter(s => s && !/^text=/i.test(s) && !s.includes('/'));
}

function snapshotExpression(adapter) {
    const css = plainCssSelectors(adapter.signedOutSelectors);
    return `(() => {
        const href = location.href || '';
        const bodyText = (document.body && (document.body.innerText || document.body.textContent)) || '';
        const signedOutText = /Log in or create an account/i.test(bodyText);
        const cssSels = ${JSON.stringify(css)};
        let signedOutCss = false;
        for (const sel of cssSels) {
            try { if (document.querySelector(sel)) { signedOutCss = true; break; } } catch (e) {}
        }
        const el = document.querySelector('textarea[placeholder="Message"]');
        let inputVisible = false;
        if (el) {
            const st = window.getComputedStyle(el);
            const r = el.getBoundingClientRect();
            inputVisible = r.width > 0 && r.height > 0
                && st.display !== 'none' && st.visibility !== 'hidden';
        }
        return { href, inputVisible, signedOutText, signedOutCss };
    })()`;
}

function classifySnapshot(snap, adapter) {
    const href = snap && snap.href;
    if (hrefMatchesAuth(href, adapter.authDomains) || (snap && (snap.signedOutText || snap.signedOutCss))) {
        return { state: 'needs_human', reason: 'muse_login' };
    }
    if (snap && snap.inputVisible) return { state: 'ready', reason: null };
    return { state: 'blocked', reason: 'no_input' };
}

function resultBase(port, seatInfo, now) {
    return {
        state: 'blocked',
        reason: 'cdp_error',
        seat: seatInfo.seat,
        port: Number(port),
        display: seatInfo.display,
        checked_at: new Date(now).toISOString(),
    };
}

async function waitForCreatedTarget(getJson, listUrl, targetId, tries = 8) {
    for (let i = 0; i < tries; i++) {
        const list = await getJson(listUrl);
        const hit = (Array.isArray(list) ? list : []).find(t => t && (t.id === targetId || t.targetId === targetId));
        if (hit) return hit;
        const muse = musePageTarget(list);
        if (muse) return muse;
        await sleep(150);
    }
    return null;
}

async function pollSnapshot(pageClient, adapter, opts) {
    const timeoutMs = opts.pollTimeoutMs != null ? opts.pollTimeoutMs : POLL_TIMEOUT_MS;
    const interval = opts.pollMs != null ? opts.pollMs : POLL_MS;
    const deadline = (opts.now || Date.now)() + timeoutMs;
    const expr = snapshotExpression(adapter);
    let lastErr = null;
    let sawOk = false;
    let lastClass = null;
    for (;;) {
        try {
            const raw = await pageClient.send('Runtime.evaluate', {
                expression: expr,
                returnByValue: true,
            });
            const snap = raw && raw.result && raw.result.value;
            if (!snap || typeof snap !== 'object') {
                lastErr = new Error('evaluate returned no value');
            } else {
                sawOk = true;
                lastClass = classifySnapshot(snap, adapter);
                if (lastClass.state === 'ready' || lastClass.state === 'needs_human') return lastClass;
            }
        } catch (e) {
            lastErr = e;
        }
        const now = (opts.now || Date.now)();
        if (now >= deadline) break;
        await sleep(interval);
    }
    if (lastClass) return lastClass;
    if (!sawOk) {
        const err = lastErr || new Error('cdp evaluate timeout');
        err.code = 'CDP_ERROR';
        throw err;
    }
    return lastClass || { state: 'blocked', reason: 'no_input' };
}

/**
 * Live read-only probe.
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {number} [opts.pid]
 * @param {(msg: string) => void} [opts.log]
 * @param {number} [opts.pollMs]
 * @param {number} [opts.pollTimeoutMs]
 * @param {() => number} [opts.now]
 * @param {object} [deps]
 * @param {(url: string, timeoutMs?: number) => Promise<any>} [deps.getJson]
 * @param {(url: string) => Promise<{send: Function, close: Function}>} [deps.wsConnect]
 * @param {(port: number) => object} [deps.readSeatLock]
 * @param {(port: number) => {pid?: number, display?: string|null, error?: string}} [deps.readChromeDisplay]
 */
async function probe(opts = {}, deps = {}) {
    const env = opts.env || process.env;
    const log = opts.log || ((msg) => process.stderr.write(`[muse] ${msg}\n`));
    const nowFn = opts.now || Date.now;
    const now = nowFn();
    const host = env.CDP_HOST || DEFAULT_HOST;
    const port = parseInt(env.CDP_PORT || String(DEFAULT_MUSE_PORT), 10);
    const seatInfo = expectedSeat(port);
    const base = () => resultBase(port, seatInfo, nowFn());
    const getJson = deps.getJson || defaultGetJson;
    const wsConnect = deps.wsConnect || defaultWsConnect;
    const readLock = deps.readSeatLock || ((p) => readSeatLock(p, { env, now: nowFn() }));
    const readDisplay = deps.readChromeDisplay || defaultReadChromeDisplay;
    const adapter = deps.adapter || loadMuseAdapter();
    const selfPid = opts.pid != null ? Number(opts.pid) : process.pid;

    const origin = `http://${host}:${port}`;
    let version;
    try {
        version = await getJson(`${origin}/json/version`);
        if (!version) throw new Error('empty version');
    } catch (e) {
        log(`doctor: CDP /json/version failed (${e && e.message ? e.message : e})`);
        return { ...base(), state: 'blocked', reason: 'seat' };
    }

    if (isLocalHost(host) && seatInfo.display) {
        const proc = readDisplay(port, host);
        if (proc && proc.display != null) {
            const got = normDisplay(proc.display);
            const want = normDisplay(seatInfo.display);
            if (got && want && got !== want) {
                log(`doctor: DISPLAY mismatch want=${want} got=${got} pid=${proc.pid || '?'}`);
                return { ...base(), state: 'blocked', reason: 'seat' };
            }
        } else {
            log(`doctor: Chrome DISPLAY not determinable (${(proc && proc.error) || 'unknown'}) — continuing`);
        }
    }

    try {
        const lock = readLock(port);
        if (lock && lock.state === 'held') {
            const ownerPid = lock.pid == null ? null : Number(lock.pid);
            const ownedBySelf = ownerPid != null && ownerPid === selfPid;
            if (!ownedBySelf) {
                log(`doctor: seat lock held by ${lock.owner || '?'} pid=${lock.pid || 'none'} — blocked:busy`);
                return { ...base(), state: 'blocked', reason: 'busy' };
            }
        }
    } catch (e) {
        log(`doctor: seat lock read failed (${e && e.message ? e.message : e}) — continuing`);
    }

    let browserClient = null;
    let pageClient = null;
    let createdId = null;
    const methodsUsed = [];
    const wrapSend = (client) => {
        const orig = client.send.bind(client);
        client.send = (method, params) => {
            methodsUsed.push(method);
            if (method === 'Page.bringToFront' || method === 'Target.activateTarget') {
                return Promise.reject(new Error(`doctor refused ${method}`));
            }
            return orig(method, params);
        };
        return client;
    };

    try {
        let list;
        try {
            list = await getJson(`${origin}/json/list`);
        } catch (e) {
            log(`doctor: /json/list failed (${e && e.message ? e.message : e})`);
            return { ...base(), state: 'blocked', reason: 'cdp_error' };
        }

        let page = musePageTarget(list);
        if (!page) {
            const wsUrl = version.webSocketDebuggerUrl;
            if (!wsUrl) throw new Error('no webSocketDebuggerUrl');
            browserClient = wrapSend(await wsConnect(wsUrl));
            const created = await browserClient.send('Target.createTarget', {
                url: MUSE_HOME,
                background: true,
            });
            createdId = created && (created.targetId || created.id);
            if (!createdId) throw new Error('createTarget returned no targetId');
            log('doctor: opened background muse.ai tab (will close)');
            page = await waitForCreatedTarget(getJson, `${origin}/json/list`, createdId);
            if (!page || !page.webSocketDebuggerUrl) {
                throw new Error('created target has no websocket');
            }
        }

        pageClient = wrapSend(await wsConnect(page.webSocketDebuggerUrl));
        const classified = await pollSnapshot(pageClient, adapter, {
            pollMs: opts.pollMs,
            pollTimeoutMs: opts.pollTimeoutMs,
            now: nowFn,
        });
        if (classified.reason === 'target_platform') {
            return { ...base(), state: 'blocked', reason: 'cdp_error' };
        }
        return {
            ...base(),
            state: classified.state,
            reason: classified.reason,
            _methods: methodsUsed,
            _createdTargetId: createdId,
        };
    } catch (e) {
        log(`doctor: CDP error (${e && e.message ? e.message : e})`);
        return {
            ...base(),
            state: 'blocked',
            reason: 'cdp_error',
            _methods: methodsUsed,
            _createdTargetId: createdId,
        };
    } finally {
        if (pageClient) {
            try { pageClient.close(); } catch (_) {}
        }
        if (createdId && browserClient) {
            try {
                await browserClient.send('Target.closeTarget', { targetId: createdId });
                log('doctor: closed background tab');
            } catch (e) {
                log(`doctor: closeTarget failed (${e && e.message ? e.message : e})`);
            }
        }
        if (browserClient) {
            try { browserClient.close(); } catch (_) {}
        }
    }
}

module.exports = {
    DEFAULT_MUSE_PORT,
    PUBLIC_KEYS,
    BLOCKED_REASONS,
    probe,
    publicResult,
    exitCodeFor,
    expectedSeat,
    musePageTarget,
    classifySnapshot,
    hrefMatchesAuth,
    snapshotExpression,
};
