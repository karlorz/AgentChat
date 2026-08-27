#!/usr/bin/env node
/**
 * /agentweb-setup — detect provider sessions on the ALREADY-RUNNING Chrome
 * (CDP attach only) and ask the user to log in anything that is not ready.
 *
 * This is setup/detect only. It never sends chat messages, never types
 * passwords or 2FA, and never starts a second Chrome / :8737 / chrome-debug
 * unless a CDP endpoint is already up and we are only attaching.
 *
 * Usage:
 *   node skills/AgentChat-agentweb-setup/index.js
 *   node skills/AgentChat-agentweb-setup/index.js --no-open
 *   node skills/AgentChat-agentweb-setup/index.js --dry-detect --fixtures=path.json
 *
 * Exit codes:
 *   0  classified (even if some providers are not ready)
 *   1  Chrome CDP not reachable (live mode)
 *   4  internal error
 *  64  usage error
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { PROVIDER_CHAIN } = require('../lib/providers/chain');
const {
    STATUSES,
    LOGIN_NEEDED,
    classifySession,
    classifyMany,
    getProviderHosts,
    isProviderHost,
} = require('../lib/providers/sessionState');
const { makeRunId, emitReceipt } = require('../lib/receipt');
const { log: _log } = require('../lib/terminal');

const SKILL_DIR = __dirname;
const SKILL = 'agentweb-setup';
const PREFIX = 'agentweb-setup';
const log = (msg) => _log(PREFIX, msg);

const DEFAULT_TOTAL_TIMEOUT = 120_000;

function usage() {
    return [
        'Usage: node index.js [--dry-detect] [--fixtures=PATH] [--no-open] [--json]',
        '  --dry-detect          classify fixtures only; no live Chrome',
        '  --fixtures=PATH       JSON snapshot map/list (required-ish for --dry-detect)',
        '  --no-open             do not open new tabs or navigate existing tabs to login URLs',
        '  --json                also print a machine JSON blob on stdout after the table',
        '',
        'Attach-only live mode uses CDP_HOST/CDP_PORT from skills/lib/cdp.js (.env).',
        'Never autostarts Chrome. Box contract: profile5 / 127.0.0.1:9227 / AGENTCHAT_NO_AUTOSTART=1.',
    ].join('\n');
}

function parseArgs(argv) {
    const out = {
        dryDetect: false,
        fixturesPath: null,
        noOpen: false,
        json: false,
        help: false,
    };
    for (const a of argv) {
        if (a === '--dry-detect' || a === '--dry-run') out.dryDetect = true;
        else if (a === '--no-open') out.noOpen = true;
        else if (a === '--json') out.json = true;
        else if (a === '--help' || a === '-h') out.help = true;
        else if (a.startsWith('--fixtures=')) out.fixturesPath = a.slice('--fixtures='.length);
        else if (a === '--fixtures') {
            // tolerate `--fixtures path`
            out._fixturesNext = true;
        } else if (out._fixturesNext) {
            out.fixturesPath = a;
            delete out._fixturesNext;
        } else {
            out._unknown = a;
        }
    }
    return out;
}

function loadFixtures(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
        const map = Object.create(null);
        for (const item of data) {
            const key = (item && (item.key || item.provider || item.providerKey)) || '';
            if (key) map[key] = item;
        }
        return hydrateFixtures(map, filePath);
    }
    return hydrateFixtures(data && typeof data === 'object' ? data : {}, filePath);
}

function hydrateFixtures(map, filePath) {
    const dir = path.dirname(path.resolve(filePath));
    for (const key of Object.keys(map)) {
        const item = map[key];
        if (!item || typeof item !== 'object') continue;
        if (item.htmlFile && !item.html) {
            try {
                item.html = fs.readFileSync(path.join(dir, item.htmlFile), 'utf8');
            } catch (_) { /* fixture html is optional */ }
        }
    }
    return map;
}

function findProviderPage(context, provider) {
    const hosts = getProviderHosts(provider);
    return context.pages().find(p => {
        try {
            const pageUrl = p.url();
            if (!pageUrl || pageUrl.startsWith('about:')) return false;
            const host = new URL(pageUrl).hostname;
            return hosts.some(h => host === h || host.endsWith('.' + h));
        } catch (_) { return false; }
    }) || null;
}

async function snapshotPage(page) {
    const url = page.url();
    let title = '';
    try { title = await page.title(); } catch (_) {}
    let body = {
        text: '',
        buttons: [],
        hasEditor: false,
        hasPassword: false,
        html: '',
    };
    try {
        body = await page.evaluate(() => {
            const vis = (el) => {
                for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
                    if (n.hasAttribute('hidden')) return false;
                    let s;
                    try { s = window.getComputedStyle(n); } catch (_) { return true; }
                    if (!s) return true;
                    if (s.display === 'none' || s.visibility === 'hidden') return false;
                }
                return true;
            };
            const buttons = [];
            for (const el of document.querySelectorAll('button, a[role="button"], [role="button"]')) {
                if (!vis(el)) continue;
                const label = ((el.innerText || el.getAttribute('aria-label') || '') + '').replace(/\s+/g, ' ').trim();
                if (label && buttons.length < 40) buttons.push(label);
            }
            let hasEditor = false;
            for (const el of document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')) {
                if (el.hasAttribute('readonly') || el.hasAttribute('disabled')) continue;
                if (vis(el)) { hasEditor = true; break; }
            }
            let hasPassword = false;
            for (const el of document.querySelectorAll('input[type="password"]')) {
                if (vis(el)) { hasPassword = true; break; }
            }
            const text = ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
            const htmlSrc = (document.documentElement && document.documentElement.innerHTML) || '';
            let html = '';
            if (/this organiz?ation has been disabled/i.test(htmlSrc) || /this organiz?ation has been disabled/i.test(text)) {
                html = 'This organization has been disabled';
            }
            const sideNameEl = document.querySelector('.sidebar-user-name, .userInfoBar .sidebar-user-name, p.sidebar-user-name');
            const sidebarUser = sideNameEl && vis(sideNameEl)
                ? ((sideNameEl.innerText || '') + '').replace(/\s+/g, ' ').trim()
                : '';
            let sidebarLoggedOut = false;
            if (/guest-avatar/i.test(htmlSrc) && /^(未登录|登录|登入|Sign in|Log ?in)$/i.test(sidebarUser)) {
                sidebarLoggedOut = true;
            }
            for (const el of document.querySelectorAll('.userInfoBar, .sidebar-user-entry')) {
                const t = ((el.innerText || '') + '').replace(/\s+/g, ' ').trim();
                if (/未登录/.test(t) || /^(登录|登入)$/.test(sidebarUser)) { sidebarLoggedOut = true; break; }
            }
            if (/sidebar-user-name[^>]*>\s*(登录|未登录|登入)\s*</i.test(htmlSrc)) {
                sidebarLoggedOut = true;
                if (!html) html = '<p class="sidebar-user-name">' + (sidebarUser || '登录') + '</p>';
            }
            let captcha = false;
            if (/access verification/i.test(text) || /滑动验证/.test(text) || /安全验证/.test(text) || /slide to verify/i.test(text)) {
                captcha = true;
            }
            if (document.querySelector('[class*="captcha"], [id*="captcha"], iframe[src*="captcha"]')) {
                captcha = true;
            }
            if (captcha && !html) html = 'Access Verification';
            return { text, buttons, hasEditor, hasPassword, html, sidebarUser, sidebarLoggedOut, captcha };
        });
    } catch (_) { /* navigation race — classify from URL only */ }
    return {
        url,
        title,
        text: body.text || '',
        buttons: body.buttons || [],
        hasEditor: !!body.hasEditor,
        hasPassword: !!body.hasPassword,
        html: body.html || '',
        sidebarUser: body.sidebarUser || '',
        sidebarLoggedOut: !!body.sidebarLoggedOut,
        captcha: !!body.captcha,
        present: true,
    };
}

/**
 * Claude 2026-08-27 live: composer stays visible while send is a no-op
 * ("This organization has been disabled"). The banner is often absent;
 * /api/organizations.api_disabled_reason on the chat org is the signal.
 * Never logs emails / org names / uuids.
 */
async function enrichClaudeOrg(page, snap) {
    try {
        const info = await page.evaluate(async () => {
            const r = await fetch('/api/organizations', { credentials: 'include' });
            if (!r.ok) return { ok: false };
            const orgs = await r.json();
            if (!Array.isArray(orgs) || !orgs.length) return { ok: false };
            const chat = orgs.find(o => Array.isArray(o.capabilities) && o.capabilities.includes('chat')) || orgs[0];
            const reason = chat && chat.api_disabled_reason;
            if (reason && reason !== 'out_of_credits') return { ok: true, reason: String(reason) };
            return { ok: true, healthy: true };
        });
        if (info && info.reason) snap.orgDisabledReason = info.reason;
        else if (info && info.healthy) snap.orgHealthy = true;
    } catch (_) { /* classify from DOM only */ }
    return snap;
}

/**
 * Send-probe that never delivers a chat turn: intercept Claude POST
 * completions, type a one-glyph marker, click Send, abort the request,
 * then clear the composer. Silent no-op (no POST, no toast) => sendNoop.
 */
async function probeClaudeSend(page, snap) {
    if (!page || snap.orgDisabledReason || snap.orgDisabled) {
        if (snap.orgDisabledReason || snap.orgDisabled) snap.sendNoop = true;
        return snap;
    }
    let attempted = 0;
    const onRoute = async (route) => {
        try {
            const req = route.request();
            const u = req.url();
            const m = req.method();
            if (m === 'POST' && /claude\.ai/i.test(u) && /\/api\//i.test(u)
                && /(completion|append_message|chat_conversations|chat_messages)/i.test(u)) {
                attempted += 1;
                await route.abort('failed');
                return;
            }
            await route.continue();
        } catch (_) {
            try { await route.continue(); } catch (__) {}
        }
    };
    try {
        await page.route('**/*', onRoute);
        const result = await page.evaluate(async () => {
            const editor = document.querySelector('.ProseMirror, div[role="textbox"], [contenteditable="true"]');
            const send = document.querySelector('button[aria-label="Send message"], button[aria-label="Send Message"], button[aria-label="Send"]');
            if (!editor || !send) return { missing: true };
            try {
                editor.focus();
                document.execCommand('selectAll', false, null);
                document.execCommand('insertText', false, '\u00b7');
            } catch (_) {}
            send.click();
            await new Promise(r => setTimeout(r, 500));
            const text = ((document.body && document.body.innerText) || '');
            const toast = /this organiz?ation has been disabled/i.test(text);
            try {
                editor.focus();
                document.execCommand('selectAll', false, null);
                document.execCommand('delete', false, null);
            } catch (_) {}
            return { toast };
        });
        if (result && result.toast) {
            snap.orgDisabled = true;
            snap.sendNoop = true;
            snap.sendNoopReason = 'toast after send-probe';
        } else if (attempted > 0) {
            snap.sendOk = true;
        } else {
            snap.sendNoop = true;
            snap.sendNoopReason = 'send-probe no-op';
        }
    } catch (_) {
        if (!snap.sendOk && !snap.orgHealthy) {
            snap.sendNoop = true;
            snap.sendNoopReason = snap.sendNoopReason || 'send-probe failed';
        }
    } finally {
        try { await page.unroute('**/*', onRoute); } catch (_) {}
    }
    return snap;
}

/** Detach from the shared profile5 CDP. Do not call browser.close — that drops CDP. */
function detachBrowser(browser) {
    if (!browser) return;
    try { browser.removeAllListeners('disconnected'); } catch (_) {}
    // Detach the Playwright guest only. NEVER close the shared browser — that logs
    // CRITICAL CDP drop and can tear down the shared profile5 session.
    if (typeof browser.disconnect === 'function') {
        try { browser.disconnect(); } catch (_) {}
    }
}

async function openOfficialInExistingChrome(context, provider, logFn) {
    const url = provider.url;
    const say = logFn || log;
    try {
        const page = await context.newPage();
        say(`${provider.name}: no tab — opening official URL in existing Chrome: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch((e) => {
            say(`${provider.name}: goto failed (${e.message}); URL is ${url}`);
        });
        return true;
    } catch (e) {
        say(`${provider.name}: open new tab failed — ${e.message}; URL ${url}`);
        return false;
    }
}

function pad(s, n) {
    s = String(s);
    return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function printTable(rows) {
    const lines = [];
    lines.push(pad('Provider', 12) + pad('Status', 28) + 'Evidence / URL');
    lines.push('-'.repeat(92));
    for (const r of rows) {
        const name = r.provider ? r.provider.name : (r.providerKey || '?');
        const ev = (r.evidence || r.url || '').replace(/\s+/g, ' ').slice(0, 80);
        lines.push(pad(name, 12) + pad(r.status, 28) + ev);
    }
    return lines.join('\n');
}

function suggestLines(rows) {
    const notReady = rows.filter(r => r.status !== STATUSES.READY);
    if (!notReady.length) return 'All PROVIDER_CHAIN sessions look ready.';
    const lines = ['Suggested setup (not ready) — log in yourself; this CLI never types passwords or 2FA:'];
    for (const r of notReady) {
        const name = r.provider ? r.provider.name : r.providerKey;
        const url = (r.provider && r.provider.url) || r.loginUrl || '';
        if (r.status === STATUSES.ORG_DISABLED) {
            lines.push(`  - ${name}: org_disabled — signed in but send is a no-op ("This organization has been disabled"). Opening the login URL will not fix this; switch org/account or skip.`);
        } else if (r.status === STATUSES.QUOTA) {
            lines.push(`  - ${name}: quota — wait or switch account. ${url}`);
        } else if (r.status === STATUSES.REGION_BLOCK_UNTIL_LOGIN) {
            lines.push(`  - ${name}: region_block_until_login — open ${url} and log in (gate may lift; re-run /agentweb-setup).`);
        } else if (r.status === STATUSES.NO_TAB) {
            lines.push(`  - ${name}: no tab — opening official URL in the existing Chrome: ${url}`);
        } else {
            lines.push(`  - ${name}: ${r.status} — open ${url}`);
        }
    }
    return lines.join('\n');
}

function finish(ctx, code, extra) {
    emitReceipt({
        skillDir: SKILL_DIR,
        skill: SKILL,
        runId: ctx.runId,
        fields: {
            exit: code,
            total_ms: Date.now() - ctx.t0,
            dry_detect: !!ctx.dryDetect,
            statuses: ctx.statuses || {},
            ready: ctx.ready || [],
            not_ready: ctx.notReady || [],
            opened_login: ctx.openedLogin || [],
            ...(extra || {}),
        },
        stream: 'stderr',
    });
    process.exit(code);
}

async function classifyLive(opts, ctx) {
    // Load CDP helpers only on the live path so --dry-detect stays Chrome-free.
    const { chromium } = require('playwright-core');
    const { connectWithRetry, probeCdp, CDP_URL } = require('../lib/cdp');

    if (!(await probeCdp(CDP_URL, 4000))) {
        log(`Chrome CDP is NOT reachable on ${CDP_URL}`);
        log('Attach-only: will not start Chrome, :8737, or scripts/chrome-debug.');
        log('Start the existing profile5 Chrome with remote debugging on 9227, then re-run.');
        for (const p of PROVIDER_CHAIN) {
            log(`  official URL ${p.name}: ${p.url}`);
        }
        ctx.statuses = Object.fromEntries(PROVIDER_CHAIN.map(p => [p.key, STATUSES.NO_TAB]));
        ctx.notReady = PROVIDER_CHAIN.map(p => p.key);
        finish(ctx, 1, { cdp: CDP_URL, error: 'cdp_unreachable' });
    }

    log(`Attaching to already-running Chrome at ${CDP_URL} (no autostart)`);
    const browser = await connectWithRetry(chromium, CDP_URL, 3, log);
    const context = browser.contexts()[0];
    if (!context) {
        log('CDP reachable but no browser context exists.');
        ctx.statuses = Object.fromEntries(PROVIDER_CHAIN.map(p => [p.key, STATUSES.NO_TAB]));
        ctx.notReady = PROVIDER_CHAIN.map(p => p.key);
        detachBrowser(browser);
        finish(ctx, 1, { error: 'no_context' });
    }

    const rows = [];
    for (const provider of PROVIDER_CHAIN) {
        const page = findProviderPage(context, provider);
        let snap;
        if (!page) {
            snap = { present: false };
        } else {
            snap = await snapshotPage(page);
            if (provider.key === 'claude') {
                snap = await enrichClaudeOrg(page, snap);
                snap = await probeClaudeSend(page, snap);
            }
        }
        const result = classifySession(snap, provider);
        rows.push({ provider, page, ...result });
        log(`${provider.name}: ${result.status} — ${result.evidence || result.url || 'no tab'}`);
    }

    const openedLogin = [];
    if (!opts.noOpen) {
        for (const r of rows) {
            if (!LOGIN_NEEDED.has(r.status)) continue;
            if (r.status === STATUSES.NO_TAB) {
                // Not ready AND no tab → OPEN a new tab on the official URL
                // in this already-running Chrome. Never start a second Chrome
                // / :8737 / scripts/chrome-debug.
                const opened = await openOfficialInExistingChrome(context, r.provider, log);
                if (opened) openedLogin.push(r.provider.key);
                continue;
            }
            // Reuse the existing provider tab. Never type credentials.
            try {
                if (r.page && !r.page.isClosed()) {
                    log(`${r.provider.name}: opening official URL (no password/2FA typing): ${r.provider.url}`);
                    await r.page.goto(r.provider.url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch((e) => {
                        log(`${r.provider.name}: goto failed (${e.message}); URL is ${r.provider.url}`);
                    });
                    openedLogin.push(r.provider.key);
                } else {
                    const opened = await openOfficialInExistingChrome(context, r.provider, log);
                    if (opened) openedLogin.push(r.provider.key);
                }
            } catch (e) {
                log(`${r.provider.name}: open failed — ${e.message}; URL ${r.provider.url}`);
            }
        }
    }

    // Detach only. Leave the shared profile5 CDP (127.0.0.1:9227) attached.
    detachBrowser(browser);
    return { rows, openedLogin, cdp: CDP_URL };
}

function classifyFixtures(opts) {
    if (!opts.fixturesPath) {
        throw Object.assign(new Error('--dry-detect requires --fixtures=PATH (JSON snapshots; no live Chrome)'), { code: 64 });
    }
    const map = loadFixtures(opts.fixturesPath);
    const rows = PROVIDER_CHAIN.map((provider) => {
        const snap = map[provider.key] || map[provider.name] || { present: false };
        return { provider, ...classifySession(snap, provider) };
    });
    return { rows, openedLogin: [], cdp: null };
}

async function main() {
    const ctx = { runId: makeRunId(), t0: Date.now(), dryDetect: false };
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log(usage());
        finish(ctx, 0, { help: true });
    }
    if (opts._unknown) {
        console.error(usage());
        log(`ERROR: unknown argument ${opts._unknown}`);
        finish(ctx, 64, { error: 'usage' });
    }

    ctx.dryDetect = opts.dryDetect;
    let pack;
    try {
        if (opts.dryDetect) pack = classifyFixtures(opts);
        else pack = await classifyLive(opts, ctx);
    } catch (e) {
        const code = e && e.code === 64 ? 64 : 4;
        if (code === 64) console.error(usage());
        log(`ERROR: ${e.message}`);
        finish(ctx, code, { error: e.message });
    }

    const { rows, openedLogin } = pack;
    ctx.statuses = Object.fromEntries(rows.map(r => [r.provider.key, r.status]));
    ctx.ready = rows.filter(r => r.status === STATUSES.READY).map(r => r.provider.key);
    ctx.notReady = rows.filter(r => r.status !== STATUSES.READY).map(r => r.provider.key);
    ctx.openedLogin = openedLogin;

    const table = printTable(rows);
    const suggest = suggestLines(rows);
    process.stdout.write(table + '\n\n' + suggest + '\n');
    if (opts.json) {
        process.stdout.write(JSON.stringify({
            statuses: ctx.statuses,
            ready: ctx.ready,
            not_ready: ctx.notReady,
            opened_login: openedLogin,
            rows: rows.map(r => ({
                key: r.provider.key,
                name: r.provider.name,
                status: r.status,
                evidence: r.evidence,
                url: r.url,
                loginUrl: r.loginUrl,
            })),
        }, null, 2) + '\n');
    }

    finish(ctx, 0, { cdp: pack.cdp || undefined });
}

if (require.main === module) {
    main().catch((e) => {
        try { log(`FATAL: ${e && e.stack || e}`); } catch (_) {}
        try {
            emitReceipt({
                skillDir: SKILL_DIR,
                skill: SKILL,
                runId: makeRunId(),
                fields: { exit: 4, error: String(e && e.message || e) },
                stream: 'stderr',
            });
        } catch (_) {}
        process.exit(4);
    });
}

module.exports = {
    parseArgs,
    loadFixtures,
    printTable,
    suggestLines,
    classifyFixtures,
    SKILL,
    STATUSES,
    LOGIN_NEEDED,
    PROVIDER_CHAIN,
    classifySession,
    classifyMany,
    isProviderHost,
    detachBrowser,
    openOfficialInExistingChrome,
    enrichClaudeOrg,
    probeClaudeSend,
    DEFAULT_TOTAL_TIMEOUT,
};
