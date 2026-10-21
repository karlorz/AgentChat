#!/usr/bin/env node
'use strict';

/**
 * Muse chat-target resolver, path-aware nav reuse, and quotaIgnoreSelectors.
 */
const assert = require('assert');
const { JSDOM } = require('jsdom');

const muse = require('../providers/adapters/muse');
const {
    resolveMuseChatUrl,
    museChatPathsMatch,
    isDedicatedMuseThreadPath,
    MUSE_HOME,
    MUSE_NEW_SESSION,
} = muse;
const { navAlreadyOn, quotaScanInPage } = require('../providerFactory');
const chain = require('../providers/chain');

let pass = 0, fail = 0;
const test = (name, fn) => {
    try {
        fn();
        pass++;
        console.log('  PASS', name);
    } catch (err) {
        fail++;
        console.log('  FAIL', name, err && err.message);
    }
};

const UUID = '411d43f8-8092-45b9-86f2-b5e24da2e9c1';
const THREAD = `https://muse.ai/thread/${UUID}`;

test('default (no env) is new session', () => {
    const prev = process.env.AGENTCHAT_MUSE_URL;
    delete process.env.AGENTCHAT_MUSE_URL;
    try {
        assert.strictEqual(resolveMuseChatUrl(undefined, {}), MUSE_NEW_SESSION);
        assert.strictEqual(resolveMuseChatUrl('', {}), MUSE_NEW_SESSION);
        assert.strictEqual(resolveMuseChatUrl('new', {}), MUSE_NEW_SESSION);
        assert.strictEqual(resolveMuseChatUrl('thread/new', {}), MUSE_NEW_SESSION);
    } finally {
        if (prev == null) delete process.env.AGENTCHAT_MUSE_URL;
        else process.env.AGENTCHAT_MUSE_URL = prev;
    }
});

test('main / Main chat / home → Main chat', () => {
    assert.strictEqual(resolveMuseChatUrl('main', {}), MUSE_HOME);
    assert.strictEqual(resolveMuseChatUrl('Main chat', {}), MUSE_HOME);
    assert.strictEqual(resolveMuseChatUrl('home', {}), MUSE_HOME);
    assert.strictEqual(resolveMuseChatUrl('https://muse.ai/', {}), MUSE_HOME);
    assert.strictEqual(resolveMuseChatUrl('https://muse.ai', {}), MUSE_HOME);
});

test('existing thread uuid and URL', () => {
    assert.strictEqual(resolveMuseChatUrl(UUID, {}), THREAD);
    assert.strictEqual(resolveMuseChatUrl(THREAD, {}), THREAD);
    assert.strictEqual(resolveMuseChatUrl(THREAD + '/', {}), THREAD);
});

test('env AGENTCHAT_MUSE_URL is read when raw is empty', () => {
    assert.strictEqual(resolveMuseChatUrl('', { AGENTCHAT_MUSE_URL: 'main' }), MUSE_HOME);
    assert.strictEqual(resolveMuseChatUrl(undefined, { AGENTCHAT_MUSE_URL: THREAD }), THREAD);
});

test('reject other hosts', () => {
    assert.strictEqual(resolveMuseChatUrl('https://example.com/', {}), null);
    assert.strictEqual(resolveMuseChatUrl('https://chatgpt.com/c/abc', {}), null);
    // Login subdomain is not a chat target — a run must not land on sign-in.
    assert.strictEqual(resolveMuseChatUrl('https://accounts.muse.ai/', {}), null);
    assert.strictEqual(resolveMuseChatUrl('https://www.muse.ai/', {}), null);
});

test('whitespace-only raw falls through to env', () => {
    assert.strictEqual(resolveMuseChatUrl('   ', { AGENTCHAT_MUSE_URL: 'main' }), MUSE_HOME);
});

test('CLI raw wins over env', () => {
    assert.strictEqual(
        resolveMuseChatUrl('new', { AGENTCHAT_MUSE_URL: 'main' }),
        MUSE_NEW_SESSION
    );
});

test('path match / dedicated thread', () => {
    assert.strictEqual(museChatPathsMatch(THREAD, THREAD), true);
    assert.strictEqual(museChatPathsMatch(THREAD, MUSE_NEW_SESSION), false);
    assert.strictEqual(museChatPathsMatch(MUSE_HOME, MUSE_NEW_SESSION), false);
    assert.strictEqual(isDedicatedMuseThreadPath('/thread/new'), true);
    assert.strictEqual(isDedicatedMuseThreadPath('/thread/' + UUID), true);
    assert.strictEqual(isDedicatedMuseThreadPath('/'), false);
});

test('navAlreadyOn origin mode still same-host; path mode requires pathname', () => {
    assert.strictEqual(navAlreadyOn(THREAD, MUSE_NEW_SESSION, 'origin'), true);
    assert.strictEqual(navAlreadyOn(THREAD, MUSE_NEW_SESSION, 'path'), false);
    assert.strictEqual(navAlreadyOn(MUSE_NEW_SESSION, MUSE_NEW_SESSION, 'path'), true);
    assert.strictEqual(navAlreadyOn(MUSE_HOME, MUSE_HOME, 'path'), true);
});

test('adapter ships path reuse + ignore selectors; chain default is new session', () => {
    assert.strictEqual(muse.navReuse, 'path');
    assert.ok(Array.isArray(muse.quotaIgnoreSelectors));
    assert.ok(muse.quotaIgnoreSelectors.includes('[data-message-role]'));
    assert.ok(muse.quotaIgnoreSelectors.includes('nav[aria-label="Side chats"]'));
    assert.strictEqual(muse.url, MUSE_NEW_SESSION);
    const row = chain.PROVIDER_CHAIN.find((p) => p.key === 'muse');
    assert.strictEqual(row.url, MUSE_NEW_SESSION);
});

test('quota scan restores page styles, including overlapping selectors', () => {
    const html = `<!doctype html><html><body>
      <div class="a b" style="color: red">rate limit</div>
      <div class="c">rate limit again</div>
      <p>keep</p>
    </body></html>`;
    const dom = new JSDOM(html);
    const prev = global.document;
    global.document = dom.window.document;
    try {
        const ab = dom.window.document.querySelector('.a');
        const c = dom.window.document.querySelector('.c');
        assert.ok(!/rate\s*limit/i.test(quotaScanInPage(['.a', '.b', '.c'])));
        assert.strictEqual(ab.getAttribute('style'), 'color: red');
        assert.strictEqual(c.getAttribute('style'), null, 'no leftover empty style attr');
    } finally {
        global.document = prev;
    }
});

test('quota scan ignores transcript rate limit without <main>', () => {
    const html = `<!doctype html><html><body>
      <nav aria-label="Side chats"><div>rate limit leftover title</div></nav>
      <div data-message-role="assistant">Automation run rate limit exceeded: grok bot limit</div>
      <textarea placeholder="Message"></textarea>
      <div id="live-banner">Welcome to Muse</div>
    </body></html>`;
    const dom = new JSDOM(html);
    const prev = global.document;
    global.document = dom.window.document;
    try {
        const raw = quotaScanInPage([]);
        assert.ok(/rate\s*limit/i.test(raw), 'unfiltered scan still sees transcript');
        const filtered = quotaScanInPage(muse.quotaIgnoreSelectors);
        assert.ok(!/rate\s*limit/i.test(filtered), 'filtered scan drops transcript and sidebar');
        assert.ok(/Welcome to Muse/i.test(filtered), 'filtered scan keeps live chrome');
    } finally {
        global.document = prev;
    }
});

test('quota scan still matches a live banner outside transcript', () => {
    const html = `<!doctype html><html><body>
      <div data-message-role="assistant">hello</div>
      <div class="banner">You have reached the usage limit</div>
    </body></html>`;
    const dom = new JSDOM(html);
    const prev = global.document;
    global.document = dom.window.document;
    try {
        const filtered = quotaScanInPage(muse.quotaIgnoreSelectors);
        assert.ok(/usage\s*limit/i.test(filtered));
    } finally {
        global.document = prev;
    }
});

async function asyncTests() {
    const oneWeb = require('../../AgentChat-OneWeb/index');
    const runProvider = async (standingUrl, targetUrl) => {
        let opened = 0;
        let seenOpts = null;
        const standing = { url: () => standingUrl, isClosed: () => false, close: async () => {} };
        const fresh = { url: () => 'about:blank', isClosed: () => false, close: async () => {} };
        const context = {
            pages: () => [standing],
            newPage: async () => { opened++; return fresh; },
            grantPermissions: async () => {},
        };
        const browser = { isConnected: () => true, contexts: () => [context] };
        const result = await oneWeb.tryAllProviders(
            browser, 'ping', { telemetry: {} },
            {
                startFrom: 'muse',
                singleAttempt: true,
                totalTimeout: 30_000,
                providerTimeout: 10_000,
                museTargetUrl: targetUrl,
                runners: {
                    muse: async (_page, _prompt, _timeout, _ctx, opts) => {
                        seenOpts = opts;
                        return { success: true, response: 'ok' };
                    },
                },
            }
        );
        return { result, opened, seenOpts };
    };

    try {
        const differentThread = await runProvider(THREAD, MUSE_NEW_SESSION);
        assert.strictEqual(differentThread.result.success, true);
        assert.strictEqual(differentThread.opened, 1, 'different path must open a new tab');
        assert.strictEqual(differentThread.seenOpts.targetUrl, MUSE_NEW_SESSION);
        pass++;
        console.log('  PASS OneWeb opens a new tab when the standing Muse path differs');
    } catch (err) {
        fail++;
        console.log('  FAIL OneWeb opens a new tab when the standing Muse path differs', err && err.message);
    }

    try {
        const sameThread = await runProvider(THREAD, THREAD);
        assert.strictEqual(sameThread.opened, 0, 'matching path reuses the standing tab');
        assert.strictEqual(sameThread.seenOpts.targetUrl, THREAD);
        pass++;
        console.log('  PASS OneWeb reuses the tab already on the requested Muse thread');
    } catch (err) {
        fail++;
        console.log('  FAIL OneWeb reuses the tab already on the requested Muse thread', err && err.message);
    }
}

asyncTests().then(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
});
