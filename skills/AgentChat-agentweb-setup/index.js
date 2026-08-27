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
        '  --no-open             do not navigate existing Chrome tabs to login URLs',
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
            return { text, buttons, hasEditor, hasPassword, html: '' };
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
        present: true,
    };
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
            lines.push(`  - ${name}: no tab — official URL: ${url}`);
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
        try { await browser.close(); } catch (_) {}
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
                log(`${r.provider.name}: no tab — official URL ${r.provider.url}`);
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
                    log(`${r.provider.name}: official URL ${r.provider.url}`);
                }
            } catch (e) {
                log(`${r.provider.name}: open failed — ${e.message}; URL ${r.provider.url}`);
            }
        }
    }

    // Detach without closing the user's Chrome.
    try { await browser.close(); } catch (_) {}
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
    DEFAULT_TOTAL_TIMEOUT,
};
