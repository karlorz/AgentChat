/**
 * Muse thread-tab find-or-open tests (zero-dep, mocked CDP HTTP).
 */
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const {
    findOrOpenMuseTab,
    isSignInUrl,
    SIGNEDOUT_EXPR,
    EXIT_SIGNED_OUT,
} = require(path.join(ROOT, 'skills', 'AgentChat-Muse', 'museTab.js'));

const CDP = 'http://127.0.0.1:9227';
const TH = 'https://muse.ai/thread/00000000-0000-4000-8000-000000000000';

function json(body, ok = true) {
    return { ok, json: async () => body };
}

/**
 * Fake CDP: lists = successive /json/list answers (last one repeats);
 * newResult = { method -> response|Error }.
 */
function fakeDeps({ lists, newResult = {} }) {
    const calls = [];
    let li = 0;
    let clock = 0;
    return {
        calls,
        deps: {
            fetch: async (url, opts = {}) => {
                const method = opts.method || 'GET';
                calls.push(`${method} ${url.replace(CDP, '')}`);
                if (url.endsWith('/json/list')) {
                    const l = lists[Math.min(li, lists.length - 1)];
                    li++;
                    if (l instanceof Error) throw l;
                    return json(l);
                }
                if (url.includes('/json/new?')) {
                    const r = newResult[method];
                    if (r instanceof Error) throw r;
                    return r || json({}, false);
                }
                throw new Error('unexpected ' + url);
            },
            sleep: async (ms) => { clock += ms; },
            now: () => clock,
            log: () => {},
        },
    };
}

const page = (id, url) => ({ id, type: 'page', url, webSocketDebuggerUrl: `ws://x/${id}` });

let passed = 0;
async function t(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok  ${name}`);
    } catch (e) {
        console.error(`  FAIL ${name}\n${e && e.stack ? e.stack : e}`);
        process.exit(1);
    }
}

(async () => {
    await t('reuses an existing thread tab, never opens', async () => {
        const f = fakeDeps({ lists: [[page('a', 'https://example.com/'), page('m', TH + '?x=1')]] });
        const r = await findOrOpenMuseTab(CDP, TH, f.deps);
        assert.strictEqual(r.opened, false);
        assert.strictEqual(r.tab.id, 'm');
        assert.ok(!f.calls.some((c) => c.includes('/json/new')));
    });

    await t('re-check finds a tab opened by a racing caller (no duplicate)', async () => {
        const f = fakeDeps({ lists: [[], [page('m', TH)]] });
        const r = await findOrOpenMuseTab(CDP, TH, f.deps);
        assert.strictEqual(r.opened, false);
        assert.ok(!f.calls.some((c) => c.includes('/json/new')));
    });

    await t('opens exactly one tab via PUT /json/new and waits for the thread URL', async () => {
        const f = fakeDeps({
            lists: [[], [], [page('n', 'about:blank')], [page('n', TH)]],
            newResult: { PUT: json(page('n', 'about:blank')) },
        });
        const r = await findOrOpenMuseTab(CDP, TH, f.deps);
        assert.strictEqual(r.opened, true);
        assert.strictEqual(r.tab.id, 'n');
        assert.strictEqual(f.calls.filter((c) => c.includes('/json/new')).length, 1);
        assert.ok(f.calls.includes(`PUT /json/new?${TH}`));
    });

    await t('falls back to GET /json/new when PUT is rejected', async () => {
        const f = fakeDeps({
            lists: [[], [], [page('n', TH)]],
            newResult: { PUT: json({}, false), GET: json(page('n', TH)) },
        });
        const r = await findOrOpenMuseTab(CDP, TH, f.deps);
        assert.strictEqual(r.opened, true);
        assert.deepStrictEqual(f.calls.filter((c) => c.includes('/json/new')).map((c) => c.split(' ')[0]), ['PUT', 'GET']);
    });

    await t('sign-in redirect → signedout (exit 7 territory), never logs in', async () => {
        const f = fakeDeps({
            lists: [[], [], [page('n', 'https://muse.ai/login?next=%2Fthread%2Fx')]],
            newResult: { PUT: json(page('n', 'about:blank')) },
        });
        const r = await findOrOpenMuseTab(CDP, TH, f.deps);
        assert.strictEqual(r.err, 'signedout');
        assert.strictEqual(r.detail, 'https://muse.ai/login');
        assert.strictEqual(EXIT_SIGNED_OUT, 7);
    });

    await t('/json/new failing both ways → err open', async () => {
        const f = fakeDeps({ lists: [[], []], newResult: { PUT: new Error('boom'), GET: json({}, false) } });
        const r = await findOrOpenMuseTab(CDP, TH, f.deps);
        assert.strictEqual(r.err, 'open');
    });

    await t('tab that never reaches the thread → err notab', async () => {
        const f = fakeDeps({
            lists: [[], [], [page('n', 'https://muse.ai/')]],
            newResult: { PUT: json(page('n', 'about:blank')) },
        });
        const r = await findOrOpenMuseTab(CDP, TH, f.deps);
        assert.strictEqual(r.err, 'notab');
    });

    await t('CDP list failure → err list', async () => {
        const f = fakeDeps({ lists: [new Error('ECONNREFUSED')] });
        const r = await findOrOpenMuseTab(CDP, TH, f.deps);
        assert.strictEqual(r.err, 'list');
    });

    await t('isSignInUrl / SIGNEDOUT_EXPR shape', async () => {
        assert.ok(isSignInUrl('https://muse.ai/signin'));
        assert.ok(isSignInUrl('https://accounts.google.com/o/oauth2'));
        assert.ok(!isSignInUrl(TH));
        assert.ok(!isSignInUrl('https://muse.ai/thread/authors-note'));
        assert.ok(SIGNEDOUT_EXPR.includes('textarea[placeholder="Message"]'));
        // must be a valid JS expression
        assert.doesNotThrow(() => new Function('return ' + SIGNEDOUT_EXPR));
    });

    await t('module never closes, reloads or relaunches', async () => {
        const src = require('fs').readFileSync(path.join(ROOT, 'skills', 'AgentChat-Muse', 'museTab.js'), 'utf8');
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        assert.ok(!/json\/close|Page\.reload|Target\.closeTarget|child_process|spawn/.test(code));
    });

    console.log(`test_muse_tab: ${passed} passed`);
    process.exit(0);
})();
