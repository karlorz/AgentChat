#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '../../..');
const qwenPath = path.join(ROOT, 'skills/lib/providers/adapters/qwen.js');
const qwen = require(qwenPath);

let passed = 0;
let failed = 0;

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

/**
 * Create a mock Playwright page backed by JSDOM.
 * Supports evaluate, locator(sel).first(), filter({hasText}), waitFor, getAttribute, click, textContent.
 */
function createMockPage(html) {
    const dom = new JSDOM(html, { runScripts: 'dangerously' });
    const { document, window } = dom.window;

    function makeLocator(sel, textRe) {
        const findElements = () => {
            let els = Array.from(document.querySelectorAll(sel));
            if (textRe) {
                els = els.filter(el => {
                    const t = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
                    return textRe.test(t);
                });
            }
            return els;
        };

        const wrapElement = (getEl) => ({
            isVisible: async () => {
                const el = getEl();
                if (!el) return false;
                if (el.style && el.style.display === 'none') return false;
                return true;
            },
            textContent: async () => {
                const el = getEl();
                return el ? el.textContent : null;
            },
            getAttribute: async (attr) => {
                const el = getEl();
                return el ? el.getAttribute(attr) : null;
            },
            click: async () => {
                const el = getEl();
                if (!el) throw new Error('locator.click: no element for ' + sel);
                el.click();
            },
            waitFor: async () => {
                const el = getEl();
                if (!el) throw new Error('locator.waitFor: no element for ' + sel);
            },
        });

        return {
            filter: ({ hasText }) => makeLocator(sel,
                hasText instanceof RegExp ? hasText : new RegExp(String(hasText), 'i')),
            first: () => wrapElement(() => findElements()[0] || null),
            last: () => {
                const els = findElements();
                return wrapElement(() => els[els.length - 1] || null);
            },
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
    console.log('── Qwen provider adapter modes (thinking / web search / deep research) ──');

    await test('adapter exports and configuration match contract', () => {
        assert.strictEqual(qwen.key, 'qwen');
        assert.strictEqual(typeof qwen.providerTimeoutOverride, 'function');
        assert.strictEqual(typeof qwen._ensureQwenThinkingOn, 'function');
        assert.strictEqual(typeof qwen._ensureQwenWebSearchOn, 'function');
        assert.strictEqual(typeof qwen._ensureQwenDeepResearchOn, 'function');
        assert.strictEqual(typeof qwen.preInputHook, 'function');
    });

    await test('providerTimeoutOverride returns 1800000 with DR env, undefined without', () => {
        delete process.env.AGENTCHAT_QWEN_DEEP_RESEARCH;
        delete process.env.AGENTCHAT_DEEP_RESEARCH;
        assert.strictEqual(qwen.providerTimeoutOverride(), undefined);

        process.env.AGENTCHAT_QWEN_DEEP_RESEARCH = '1';
        assert.strictEqual(qwen.providerTimeoutOverride(), 1_800_000);
        delete process.env.AGENTCHAT_QWEN_DEEP_RESEARCH;

        process.env.AGENTCHAT_DEEP_RESEARCH = '1';
        assert.strictEqual(qwen.providerTimeoutOverride(), 1_800_000);
        delete process.env.AGENTCHAT_DEEP_RESEARCH;
    });

    // ── Thinking tests ──

    await test('default-ON thinking attempt with no control in mock DOM -> missing (not an error)', async () => {
        delete process.env.AGENTCHAT_QWEN_NO_THINK;
        const page = createMockPage('<div class="composer"><button aria-label="快速">快速</button></div>');
        const res = await qwen._ensureQwenThinkingOn(page);
        assert.strictEqual(res, 'missing');
    });

    await test('thinking generic-lookup detects standalone toggle when present and already on', async () => {
        delete process.env.AGENTCHAT_QWEN_NO_THINK;
        const page = createMockPage('<div class="composer"><button aria-label="深度思考" aria-pressed="true">深度思考</button></div>');
        const res = await qwen._ensureQwenThinkingOn(page);
        assert.strictEqual(res, 'already-on');
    });

    await test('thinking generic-lookup clicks standalone toggle when off', async () => {
        delete process.env.AGENTCHAT_QWEN_NO_THINK;
        const page = createMockPage('<div class="composer"><button id="btn" aria-label="深度思考" aria-pressed="false">深度思考</button></div>');
        let clicked = false;
        page.document.getElementById('btn').addEventListener('click', () => { clicked = true; });
        const res = await qwen._ensureQwenThinkingOn(page);
        assert.strictEqual(res, 'clicked');
        assert.strictEqual(clicked, true);
    });

    await test('thinking excludes 思考研究 menu item context', async () => {
        delete process.env.AGENTCHAT_QWEN_NO_THINK;
        const page = createMockPage('<div class="composer"><div role="menuitemcheckbox">思考研究 深度搜索、深度研究</div></div>');
        const res = await qwen._ensureQwenThinkingOn(page);
        assert.strictEqual(res, 'missing');
    });

    await test('AGENTCHAT_QWEN_NO_THINK=1 skips thinking and page is never touched', async () => {
        process.env.AGENTCHAT_QWEN_NO_THINK = '1';
        try {
            const page = {
                evaluate: () => { throw new Error('should not evaluate'); },
                locator: () => { throw new Error('should not locate'); },
            };
            const res = await qwen._ensureQwenThinkingOn(page);
            assert.strictEqual(res, 'skipped');
        } finally {
            delete process.env.AGENTCHAT_QWEN_NO_THINK;
        }
    });

    // ── Web search tests ──

    await test('default-ON web-search attempt with no control in mock DOM -> missing (not an error)', async () => {
        delete process.env.AGENTCHAT_QWEN_NO_WEB_SEARCH;
        const page = createMockPage('<div class="composer"><button aria-label="快速">快速</button></div>');
        const res = await qwen._ensureQwenWebSearchOn(page);
        assert.strictEqual(res, 'missing');
    });

    await test('web search generic-lookup detects control when present and already on', async () => {
        delete process.env.AGENTCHAT_QWEN_NO_WEB_SEARCH;
        const page = createMockPage('<div class="composer"><button aria-label="联网搜索" aria-checked="true">联网搜索</button></div>');
        const res = await qwen._ensureQwenWebSearchOn(page);
        assert.strictEqual(res, 'already-on');
    });

    await test('web search generic-lookup clicks control when off', async () => {
        delete process.env.AGENTCHAT_QWEN_NO_WEB_SEARCH;
        const page = createMockPage('<div class="composer"><button id="wbtn" aria-label="联网搜索" aria-checked="false">联网搜索</button></div>');
        let clicked = false;
        page.document.getElementById('wbtn').addEventListener('click', () => { clicked = true; });
        const res = await qwen._ensureQwenWebSearchOn(page);
        assert.strictEqual(res, 'clicked');
        assert.strictEqual(clicked, true);
    });

    await test('AGENTCHAT_QWEN_NO_WEB_SEARCH=1 skips web search and page is never touched', async () => {
        process.env.AGENTCHAT_QWEN_NO_WEB_SEARCH = '1';
        try {
            const page = {
                evaluate: () => { throw new Error('should not evaluate'); },
                locator: () => { throw new Error('should not locate'); },
            };
            const res = await qwen._ensureQwenWebSearchOn(page);
            assert.strictEqual(res, 'skipped');
        } finally {
            delete process.env.AGENTCHAT_QWEN_NO_WEB_SEARCH;
        }
    });

    // ── Deep Research tests ──

    await test('DR inactive without env returns skipped', async () => {
        delete process.env.AGENTCHAT_QWEN_DEEP_RESEARCH;
        delete process.env.AGENTCHAT_DEEP_RESEARCH;
        const page = {
            evaluate: () => { throw new Error('should not evaluate'); },
            locator: () => { throw new Error('should not locate'); },
        };
        const res = await qwen._ensureQwenDeepResearchOn(page);
        assert.strictEqual(res, 'skipped');
    });

    await test('DR opt-in (AGENTCHAT_QWEN_DEEP_RESEARCH=1): clicks 思考研究 -> clicked', async () => {
        process.env.AGENTCHAT_QWEN_DEEP_RESEARCH = '1';
        try {
            const page = createMockPage(`
                <div class="composer">
                    <button id="pill" aria-label="快速" aria-haspopup="menu" aria-expanded="false">快速</button>
                    <div class="menu" style="display:none">
                        <div role="menuitemcheckbox" id="fast" aria-checked="true">快速 适用于大多数情况</div>
                        <div role="menuitemcheckbox" id="dr" aria-checked="false">思考研究 深度搜索、深度研究</div>
                    </div>
                </div>
            `);

            const pill = page.document.getElementById('pill');
            const menu = page.document.querySelector('.menu');
            const drRow = page.document.getElementById('dr');

            let pillClicked = false;
            let drClicked = false;

            pill.addEventListener('click', () => {
                pillClicked = true;
                pill.setAttribute('aria-expanded', 'true');
                menu.style.display = 'block';
            });

            drRow.addEventListener('click', () => {
                drClicked = true;
                drRow.setAttribute('aria-checked', 'true');
                pill.setAttribute('aria-label', '思考研究');
                pill.textContent = '思考研究';
            });

            const res = await qwen._ensureQwenDeepResearchOn(page);
            assert.strictEqual(res, 'clicked');
            assert.strictEqual(pillClicked, true, 'mode pill must be clicked');
            assert.strictEqual(drClicked, true, 'DR row must be clicked');
            assert.strictEqual(drRow.getAttribute('aria-checked'), 'true');
        } finally {
            delete process.env.AGENTCHAT_QWEN_DEEP_RESEARCH;
        }
    });

    await test('DR opt-in: when aria-checked already true -> already-on', async () => {
        process.env.AGENTCHAT_QWEN_DEEP_RESEARCH = '1';
        try {
            const page = createMockPage(`
                <div class="composer">
                    <button id="pill" aria-label="思考研究" aria-haspopup="menu" aria-expanded="true">思考研究</button>
                    <div class="menu">
                        <div role="menuitemcheckbox" id="fast" aria-checked="false">快速 适用于大多数情况</div>
                        <div role="menuitemcheckbox" id="dr" aria-checked="true">思考研究 深度搜索、深度研究</div>
                    </div>
                </div>
            `);

            let drClicked = false;
            page.document.getElementById('dr').addEventListener('click', () => { drClicked = true; });

            const res = await qwen._ensureQwenDeepResearchOn(page);
            assert.strictEqual(res, 'already-on');
            assert.strictEqual(drClicked, false, 'must not click when already on');
        } finally {
            delete process.env.AGENTCHAT_QWEN_DEEP_RESEARCH;
        }
    });

    await test('DR opt-in: rows absent -> missing', async () => {
        process.env.AGENTCHAT_QWEN_DEEP_RESEARCH = '1';
        try {
            const page = createMockPage(`
                <div class="composer">
                    <button id="pill" aria-label="快速" aria-haspopup="menu" aria-expanded="false">快速</button>
                    <div class="menu"></div>
                </div>
            `);

            const res = await qwen._ensureQwenDeepResearchOn(page);
            assert.strictEqual(res, 'missing');
        } finally {
            delete process.env.AGENTCHAT_QWEN_DEEP_RESEARCH;
        }
    });

    await test('DR opt-in via evaluate seam (pattern: kimi.js)', async () => {
        process.env.AGENTCHAT_QWEN_DEEP_RESEARCH = '1';
        try {
            const dom = new JSDOM(`
                <div class="composer">
                    <button id="pill" aria-label="快速">快速</button>
                    <div role="menuitemcheckbox" id="dr" aria-checked="false">思考研究 深度搜索、深度研究</div>
                </div>
            `);
            const page = {
                evaluate: async (fn) => {
                    const prevDoc = global.document;
                    try {
                        global.document = dom.window.document;
                        return await fn();
                    } finally {
                        global.document = prevDoc;
                    }
                },
                waitForTimeout: async () => {},
            };
            const res = await qwen._ensureQwenDeepResearchOn(page);
            assert.strictEqual(res, 'clicked');
        } finally {
            delete process.env.AGENTCHAT_QWEN_DEEP_RESEARCH;
        }
    });

    // ── Error handling tests ──

    await test('error path -> error, never throws', async () => {
        delete process.env.AGENTCHAT_QWEN_NO_THINK;
        delete process.env.AGENTCHAT_QWEN_NO_WEB_SEARCH;
        process.env.AGENTCHAT_QWEN_DEEP_RESEARCH = '1';
        try {
            const deadPage = {
                evaluate: async () => { throw new Error('Target closed'); },
                locator: () => { throw new Error('Target closed'); },
            };

            const tRes = await qwen._ensureQwenThinkingOn(deadPage);
            assert.strictEqual(tRes, 'error');

            const wRes = await qwen._ensureQwenWebSearchOn(deadPage);
            assert.strictEqual(wRes, 'error');

            const drRes = await qwen._ensureQwenDeepResearchOn(deadPage);
            assert.strictEqual(drRes, 'error');
        } finally {
            delete process.env.AGENTCHAT_QWEN_DEEP_RESEARCH;
        }
    });

    // ── PreInputHook wiring test ──

    await test('preInputHook runs editor wait then calls mode ensurers fail-soft', async () => {
        delete process.env.AGENTCHAT_QWEN_NO_THINK;
        delete process.env.AGENTCHAT_QWEN_NO_WEB_SEARCH;
        delete process.env.AGENTCHAT_QWEN_DEEP_RESEARCH;

        const page = createMockPage(`
            <div contenteditable="true" role="textbox"></div>
            <button aria-label="快速">快速</button>
        `);

        // Should complete cleanly without throwing
        await qwen.preInputHook(page);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
})();
