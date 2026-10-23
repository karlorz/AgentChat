/**
 * Find-or-open the Muse thread tab over raw CDP HTTP (2026-10-23 auto-open).
 *
 * After a box reset the operator Chrome came back without the standing Muse
 * thread tab, and the raw-CDP ask path failed with "no Muse thread tab"
 * (exit 4). This module fixes that without widening what the ask path may do:
 *
 *   - Reuse an existing page whose URL starts with the thread URL.
 *   - Otherwise re-check /json/list once (guards against a racing caller),
 *     then open exactly ONE tab via /json/new?<threadUrl> (PUT first, GET
 *     fallback for older Chrome builds).
 *   - Wait up to ~30 s for the new tab to settle on the thread URL.
 *   - A sign-in URL → { err: 'signedout' } (callers exit 7). Never logs in.
 *
 * Never closes or reloads tabs, never relaunches Chrome.
 *
 * findOrOpenMuseTab(cdpBase, threadUrl, deps) — deps are injectable so tests
 * can mock fetch / sleep / clock. Returns { tab, opened } or
 * { err: 'list'|'open'|'signedout'|'notab', detail, tab? }.
 */
'use strict';

const LIST_TIMEOUT_MS = 5000;
const OPEN_TIMEOUT_MS = 10_000;
const LOAD_TIMEOUT_MS = 30_000;
const LOAD_POLL_MS = 2000;
const SETTLE_MS = 6000;
const RECHECK_MS = 500;

const SIGNIN_URL_RE = /\/(login|signin|sign-in|auth)(\/|\?|$)|accounts\.google\.com|accounts\.muse\.ai/i;

/**
 * Page-side check after attaching: no composer and sign-in text (or a sign-in
 * path) means the Muse session is gone → caller exits 7, no login attempt.
 */
const SIGNEDOUT_EXPR = '(()=>{const c=document.querySelector(\'textarea[placeholder="Message"]\');'
    + 'if(c)return false;const t=(document.body&&document.body.innerText)||"";'
    + 'return /\\b(sign in|log in|continue with google|create account)\\b/i.test(t)'
    + '||/\\/(login|signin|sign-in|auth)/i.test(location.pathname);})()';

/** Exit code callers use when Muse is signed out. */
const EXIT_SIGNED_OUT = 7;

function isSignInUrl(url) {
    return SIGNIN_URL_RE.test(String(url || ''));
}

function stripQuery(url) {
    return String(url || '').split('?')[0];
}

function defaultDeps() {
    return {
        fetch: (...a) => globalThis.fetch(...a),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: () => Date.now(),
        log: (msg) => process.stderr.write(msg + '\n'),
    };
}

async function listTargets(cdpBase, d) {
    const res = await d.fetch(cdpBase + '/json/list', { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
    return res.json();
}

function findThreadPage(list, threadUrl) {
    return (list || []).find((t) => t && t.type === 'page' && String(t.url || '').startsWith(threadUrl)) || null;
}

async function findOrOpenMuseTab(cdpBase, threadUrl, deps = {}) {
    const d = { ...defaultDeps(), ...deps };
    const base = String(cdpBase || '').replace(/\/$/, '');
    let list;
    try {
        list = await listTargets(base, d);
    } catch (e) {
        return { err: 'list', detail: String(e && e.message ? e.message : e) };
    }
    let tab = findThreadPage(list, threadUrl);
    if (tab) return { tab, opened: false };

    // Re-check right before opening so two callers never open two tabs.
    await d.sleep(RECHECK_MS);
    try {
        list = await listTargets(base, d);
    } catch (e) {
        return { err: 'list', detail: String(e && e.message ? e.message : e) };
    }
    tab = findThreadPage(list, threadUrl);
    if (tab) return { tab, opened: false };

    let created = null;
    for (const method of ['PUT', 'GET']) {
        try {
            const res = await d.fetch(base + '/json/new?' + threadUrl, {
                method,
                signal: AbortSignal.timeout(OPEN_TIMEOUT_MS),
            });
            if (res.ok) {
                created = await res.json();
                break;
            }
        } catch (_) { /* try next method */ }
    }
    if (!created || !created.id) return { err: 'open', detail: 'json/new failed' };
    d.log(`opened Muse thread tab ${created.id} for ${threadUrl}`);

    const t0 = d.now();
    let cur = created;
    while (d.now() - t0 < LOAD_TIMEOUT_MS) {
        await d.sleep(LOAD_POLL_MS);
        try {
            list = await listTargets(base, d);
        } catch (_) {
            continue;
        }
        cur = (list || []).find((t) => t && t.id === created.id) || cur;
        if (isSignInUrl(cur.url)) return { err: 'signedout', detail: stripQuery(cur.url), tab: cur };
        if (String(cur.url || '').startsWith(threadUrl) && d.now() - t0 > SETTLE_MS) break;
    }
    if (isSignInUrl(cur.url)) return { err: 'signedout', detail: stripQuery(cur.url), tab: cur };
    if (!String(cur.url || '').startsWith(threadUrl)) {
        return { err: 'notab', detail: 'new tab landed on ' + stripQuery(cur.url), tab: cur };
    }
    return { tab: cur, opened: true };
}

module.exports = {
    findOrOpenMuseTab,
    findThreadPage,
    isSignInUrl,
    SIGNEDOUT_EXPR,
    SIGNIN_URL_RE,
    EXIT_SIGNED_OUT,
};
