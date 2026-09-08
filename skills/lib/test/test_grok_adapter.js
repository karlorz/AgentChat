#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '../../..');
const grokPath = path.join(ROOT, 'skills/lib/providers/adapters/grok.js');
const grok = require(grokPath);
const grokSrc = fs.readFileSync(grokPath, 'utf8');

let passed = 0, failed = 0;
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log('  PASS ' + name);
    } catch (e) {
        failed++;
        console.log('  FAIL ' + name + ' — ' + e.message);
    }
}

/** Create a mock Playwright page backed by JSDOM. */
function createMockPage(html) {
    const dom = new JSDOM(html, { runScripts: 'dangerously' });
    const { document, window } = dom.window;
    // Minimal Playwright-locator stand-in backed by the jsdom document.
    // Supports the surface our adapter helpers use: first(), filter({hasText}),
    // isVisible/textContent/click/waitFor on the first match.
    function makeLocator(sel, textRe) {
        const find = () => {
            let els = Array.from(document.querySelectorAll(sel));
            if (textRe) els = els.filter(el => textRe.test(el.textContent || ''));
            return els[0] || null;
        };
        return {
            filter: ({ hasText }) => makeLocator(sel,
                hasText instanceof RegExp ? hasText : new RegExp(String(hasText), 'i')),
            first: () => ({
                isVisible: async () => !!find(),
                textContent: async () => { const el = find(); return el ? el.textContent : null; },
                click: async () => {
                    const el = find();
                    if (!el) throw new Error('locator.click: no element for ' + sel);
                    el.click();
                },
                waitFor: async () => {
                    if (!find()) throw new Error('locator.waitFor: no element for ' + sel);
                },
            }),
        };
    }
    return {
        dom,
        document,
        window,
        evaluate: async (fn, ...args) => {
            const prevDoc = global.document;
            const prevWin = global.window;
            try {
                global.document = document;
                global.window = window;
                return await fn(...args);
            } finally {
                global.document = prevDoc;
                global.window = prevWin;
            }
        },
        waitForTimeout: async () => {},
        locator: (sel) => makeLocator(sel),
    };
}

(async () => {
    console.log('── Grok provider adapter ──');

    await test('adapter exports and configuration match contract', () => {
        assert.strictEqual(grok.key, 'grok');
        assert.strictEqual(grok.url, 'https://grok.com/');
        assert.deepStrictEqual(grok.authDomains, [
            'accounts.x.ai', 'x.ai/login', 'grok.com/login', 'x.com', 'twitter.com'
        ]);
        assert.strictEqual(grok.navPostDelay, 3000);
        assert.strictEqual(grok.stabilityWindow, 8000);
        assert.strictEqual(grok.minResponseLength, 10);
        assert.strictEqual(grok.sendFallback, 'Enter');
        assert.ok(Array.isArray(grok.editorSelectors) && grok.editorSelectors.length > 0);
        assert.ok(Array.isArray(grok.sendSelectors) && grok.sendSelectors.length > 0);
        assert.ok(Array.isArray(grok.responseSelectors) && grok.responseSelectors.length > 0);
        assert.ok(Array.isArray(grok.quotaPatterns) && grok.quotaPatterns.length > 0);
        assert.strictEqual(typeof grok.providerTimeoutOverride, 'function');
        assert.strictEqual(typeof grok._ensureGrokExpertMode, 'function');
        assert.strictEqual(typeof grok._ensureGrokDeepSearchOn, 'function');
        assert.strictEqual(typeof grok._ensureGrokDeeperSearchOn, 'function');
    });

    await test('quotaPatterns reject bare upgrade / SuperGrok upsell but match exhaustion', () => {
        const bareUpgrade = 'Upgrade to SuperGrok for unlimited reasoning';
        const bareUpsell = 'Get SuperGrok';
        const rateLimit = 'You have reached the rate limit. Please try again later.';
        const usageExceeded = 'Usage limit reached. Upgrade to SuperGrok to continue.';

        const matchesAny = (str) => grok.quotaPatterns.some(p => p.test(str));
        assert.strictEqual(matchesAny(bareUpgrade), false, 'bare SuperGrok upsell must not match quota');
        assert.strictEqual(matchesAny(bareUpsell), false, 'bare upsell must not match quota');
        assert.strictEqual(matchesAny(rateLimit), true, 'rate limit must match');
        assert.strictEqual(matchesAny(usageExceeded), true, 'usage limit with upgrade must match');
    });

    await test('Expert-mode helper selects Expert and skips Heavy', async () => {
        const page = createMockPage(`
            <form>
                <button type="button" id="mode-btn" aria-label="Model select">Fast</button>
            </form>
            <div id="menu">
                <div role="menuitemradio" class="item">Heavy (Pro)</div>
                <div role="menuitemradio" class="item">Expert (Thinks hard)</div>
                <div role="menuitemradio" class="item">Auto</div>
            </div>
        `);
        const modeBtn = page.document.getElementById('mode-btn');
        const menu = page.document.getElementById('menu');
        modeBtn.addEventListener('click', () => {
            menu.style.display = 'block';
        });
        const items = menu.querySelectorAll('.item');
        items[0].addEventListener('click', () => { modeBtn.textContent = 'Heavy'; });
        items[1].addEventListener('click', () => { modeBtn.textContent = 'Expert'; });
        items[2].addEventListener('click', () => { modeBtn.textContent = 'Auto'; });

        const res = await grok._ensureGrokExpertMode(page);
        assert.strictEqual(res, 'clicked');
        assert.strictEqual(modeBtn.textContent, 'Expert');
    });

    await test('Expert-mode skipped when already active', async () => {
        const page = createMockPage(`
            <form>
                <button type="button" id="mode-btn" aria-label="Model select">Expert</button>
            </form>
        `);
        let clicked = false;
        page.document.getElementById('mode-btn').addEventListener('click', () => {
            clicked = true;
        });
        const res = await grok._ensureGrokExpertMode(page);
        assert.strictEqual(res, 'already-on');
        assert.strictEqual(clicked, false, 'mode button must not be clicked when already Expert');
    });

    await test('Expert-mode returns missing when selector button absent', async () => {
        const page = createMockPage('<form><div contenteditable="true"></div></form>');
        const res = await grok._ensureGrokExpertMode(page);
        assert.strictEqual(res, 'missing');
    });

    await test('Expert-mode opt-out env skips DOM evaluation', async () => {
        process.env.AGENTCHAT_GROK_NO_THINK = '1';
        try {
            const res = await grok._ensureGrokExpertMode({
                evaluate: () => { throw new Error('DOM evaluate must not be called when opt-out is set'); },
            });
            assert.strictEqual(res, 'skipped');
        } finally {
            delete process.env.AGENTCHAT_GROK_NO_THINK;
        }
    });

    await test('DeepSearch clicks only a provably-off control and leaves already-on untouched', async () => {
        // Test 1: provably off via aria-pressed=false -> clicks to turn on
        const pageOff = createMockPage(`
            <form>
                <button type="button" id="ds" aria-pressed="false">DeepSearch</button>
            </form>
        `);
        let clicked = false;
        pageOff.document.getElementById('ds').addEventListener('click', () => {
            clicked = true;
            pageOff.document.getElementById('ds').setAttribute('aria-pressed', 'true');
        });
        const resOff = await grok._ensureGrokDeepSearchOn(pageOff);
        assert.strictEqual(resOff, 'clicked');
        assert.strictEqual(clicked, true);

        // Test 2: already on via aria-pressed=true -> does not click
        const pageOn = createMockPage(`
            <form>
                <button type="button" id="ds" aria-pressed="true">DeepSearch</button>
            </form>
        `);
        let clickedOn = false;
        pageOn.document.getElementById('ds').addEventListener('click', () => { clickedOn = true; });
        const resOn = await grok._ensureGrokDeepSearchOn(pageOn);
        assert.strictEqual(resOn, 'already-on');
        assert.strictEqual(clickedOn, false);
    });

    await test('DeepSearch does not click missing or ambiguous controls', async () => {
        // Missing
        const pageMissing = createMockPage('<form><textarea></textarea></form>');
        const resMissing = await grok._ensureGrokDeepSearchOn(pageMissing);
        assert.strictEqual(resMissing, 'missing');

        // Ambiguous (no state attributes)
        const pageAmbiguous = createMockPage(`
            <form>
                <button type="button" id="ds">DeepSearch</button>
            </form>
        `);
        let clickedAmb = false;
        pageAmbiguous.document.getElementById('ds').addEventListener('click', () => { clickedAmb = true; });
        const resAmb = await grok._ensureGrokDeepSearchOn(pageAmbiguous);
        assert.strictEqual(resAmb, 'unknown');
        assert.strictEqual(clickedAmb, false, 'never blind-click ambiguous controls');
    });

    await test('DeepSearch opt-out env skips DOM evaluation', async () => {
        process.env.AGENTCHAT_GROK_NO_WEB_SEARCH = '1';
        try {
            const res = await grok._ensureGrokDeepSearchOn({
                evaluate: () => { throw new Error('DOM evaluate must not be called when opt-out is set'); },
            });
            assert.strictEqual(res, 'skipped');
        } finally {
            delete process.env.AGENTCHAT_GROK_NO_WEB_SEARCH;
        }
    });

    await test('DeeperSearch inert without env, active with AGENTCHAT_GROK_DEEP_RESEARCH=1', async () => {
        // Without env: inert / skipped
        delete process.env.AGENTCHAT_GROK_DEEP_RESEARCH;
        delete process.env.AGENTCHAT_DEEP_RESEARCH;
        const pageNoEnv = createMockPage('<form><button aria-pressed="false">Deeper Search</button></form>');
        const resNoEnv = await grok._ensureGrokDeeperSearchOn(pageNoEnv);
        assert.strictEqual(resNoEnv, 'skipped');

        // With env: activates provably-off control
        process.env.AGENTCHAT_GROK_DEEP_RESEARCH = '1';
        try {
            const pageWithEnv = createMockPage(`
                <form>
                    <button type="button" id="deeper" aria-pressed="false">Deeper Search</button>
                </form>
            `);
            let clicked = false;
            pageWithEnv.document.getElementById('deeper').addEventListener('click', () => {
                clicked = true;
                pageWithEnv.document.getElementById('deeper').setAttribute('aria-pressed', 'true');
            });
            const resWithEnv = await grok._ensureGrokDeeperSearchOn(pageWithEnv);
            assert.strictEqual(resWithEnv, 'clicked');
            assert.strictEqual(clicked, true);
        } finally {
            delete process.env.AGENTCHAT_GROK_DEEP_RESEARCH;
        }
    });

    await test('providerTimeoutOverride returns 1800000 with DR env and undefined without', () => {
        delete process.env.AGENTCHAT_GROK_DEEP_RESEARCH;
        delete process.env.AGENTCHAT_DEEP_RESEARCH;
        assert.strictEqual(grok.providerTimeoutOverride(), undefined);

        process.env.AGENTCHAT_GROK_DEEP_RESEARCH = '1';
        try {
            assert.strictEqual(grok.providerTimeoutOverride(), 1_800_000);
        } finally {
            delete process.env.AGENTCHAT_GROK_DEEP_RESEARCH;
        }

        process.env.AGENTCHAT_DEEP_RESEARCH = '1';
        try {
            assert.strictEqual(grok.providerTimeoutOverride(), 1_800_000);
        } finally {
            delete process.env.AGENTCHAT_DEEP_RESEARCH;
        }
    });

    await test('preInputHook wires Expert and DeepSearch, and handles dead page gracefully', async () => {
        const deadPage = {
            locator: () => ({ first: () => ({ waitFor: async () => { throw new Error('Target closed'); } }) }),
            evaluate: async () => { throw new Error('Target closed'); },
        };
        // Should not throw
        await grok.preInputHook(deadPage);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
})();
