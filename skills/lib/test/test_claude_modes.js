#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '../../..');
const claudePath = path.join(ROOT, 'skills/lib/providers/adapters/claude.js');
const claude = require(claudePath);

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

/**
 * Create a mock Playwright page backed by JSDOM.
 * Supports locator(sel).first(), filter({hasText}), last(),
 * isVisible, textContent, click, hover, waitFor, getAttribute.
 */
function createMockPage(html) {
    const dom = new JSDOM(html, { runScripts: 'dangerously' });
    const { document, window } = dom.window;

    function makeLocator(sel, textRe) {
        const findElements = () => {
            let els = Array.from(document.querySelectorAll(sel));
            if (textRe) {
                els = els.filter(el => textRe.test(el.textContent || ''));
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
            hover: async () => {
                const el = getEl();
                if (!el) throw new Error('locator.hover: no element for ' + sel);
                const ev = new window.MouseEvent('mouseover', { bubbles: true, cancelable: true });
                el.dispatchEvent(ev);
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
        keyboard: {
            press: async (key) => {
                if (key === 'Escape') {
                    // Close open menus in fixture
                    const inert = document.querySelector('#portal-root [data-base-ui-inert]');
                    if (inert) inert.remove();
                    const menus = document.querySelectorAll('.menu, .submenu');
                    for (const m of menus) m.style.display = 'none';
                }
            },
        },
    };
}

(async () => {
    console.log('── Claude provider adapter ──');

    await test('adapter exports and configuration match contract', () => {
        assert.strictEqual(claude.key, 'claude');
        assert.strictEqual(claude.url, 'https://claude.ai/');
        assert.deepStrictEqual(claude.authDomains, ['claude.ai/login', 'auth.anthropic.com']);
        assert.strictEqual(claude.stabilityWindow, 10000);
        assert.strictEqual(claude.minResponseLength, 5);
        assert.strictEqual(claude.sendFallback, 'Enter');
        assert.ok(Array.isArray(claude.editorSelectors) && claude.editorSelectors.length > 0);
        assert.ok(Array.isArray(claude.sendSelectors) && claude.sendSelectors.length > 0);
        assert.ok(Array.isArray(claude.responseSelectors) && claude.responseSelectors.length > 0);
        assert.ok(Array.isArray(claude.quotaPatterns) && claude.quotaPatterns.length > 0);
        assert.strictEqual(typeof claude.preInputHook, 'function');
        assert.strictEqual(typeof claude.postResponseHook, 'function');
        assert.strictEqual(typeof claude.providerTimeoutOverride, 'function');
        assert.strictEqual(typeof claude._ensureClaudeWebSearchOn, 'function');
        assert.strictEqual(typeof claude._ensureClaudeThinkingOn, 'function');
        assert.strictEqual(typeof claude._ensureClaudeEffort, 'function');
        assert.strictEqual(typeof claude._ensureClaudeResearchOn, 'function');
    });

    // ── Web search tests ──

    await test('Web search: already-on (aria-checked=true) does not click', async () => {
        delete process.env.AGENTCHAT_CLAUDE_NO_WEB_SEARCH;
        const page = createMockPage(`
            <button aria-label="Add files and more">+</button>
            <div id="portal-root">
                <div role="menuitemcheckbox" aria-checked="true">Web search</div>
            </div>
        `);
        let clicked = false;
        page.document.querySelector('[role="menuitemcheckbox"]').addEventListener('click', () => {
            clicked = true;
        });

        const res = await claude._ensureClaudeWebSearchOn(page);
        assert.strictEqual(res, 'already-on');
        assert.strictEqual(clicked, false, 'must not click when already active');
    });

    await test('Web search: off (aria-checked=false) clicks and flips to true', async () => {
        delete process.env.AGENTCHAT_CLAUDE_NO_WEB_SEARCH;
        const page = createMockPage(`
            <button aria-label="Add files and more">+</button>
            <div id="portal-root">
                <div role="menuitemcheckbox" aria-checked="false">Web search</div>
            </div>
        `);
        let clicked = false;
        const item = page.document.querySelector('[role="menuitemcheckbox"]');
        item.addEventListener('click', () => {
            clicked = true;
            item.setAttribute('aria-checked', 'true');
        });

        const res = await claude._ensureClaudeWebSearchOn(page);
        assert.strictEqual(res, 'clicked');
        assert.strictEqual(clicked, true, 'must click to enable');
        assert.strictEqual(item.getAttribute('aria-checked'), 'true');
    });

    await test('Web search: missing row returns missing', async () => {
        delete process.env.AGENTCHAT_CLAUDE_NO_WEB_SEARCH;
        const page = createMockPage(`
            <button aria-label="Add files and more">+</button>
            <div id="portal-root">
                <div role="menuitem">Something else</div>
            </div>
        `);
        const res = await claude._ensureClaudeWebSearchOn(page);
        assert.strictEqual(res, 'missing');
    });

    await test('Web search: opt-out env skips DOM evaluation', async () => {
        process.env.AGENTCHAT_CLAUDE_NO_WEB_SEARCH = '1';
        try {
            const page = {
                locator: () => { throw new Error('DOM locator must not be called when opt-out is set'); },
            };
            const res = await claude._ensureClaudeWebSearchOn(page);
            assert.strictEqual(res, 'skipped');
        } finally {
            delete process.env.AGENTCHAT_CLAUDE_NO_WEB_SEARCH;
        }
    });

    // ── Thinking toggle tests ──

    await test('Thinking: already-on (aria-checked=true) does not click', async () => {
        delete process.env.AGENTCHAT_CLAUDE_NO_THINK;
        const page = createMockPage(`
            <button class="model-select">Sonnet 5</button>
            <div id="portal-root">
                <div role="menuitem">Effort</div>
                <div role="menuitemcheckbox" aria-checked="true">Thinking Can think for more complex tasks</div>
            </div>
        `);
        let clicked = false;
        page.document.querySelector('[role="menuitemcheckbox"]').addEventListener('click', () => {
            clicked = true;
        });

        const res = await claude._ensureClaudeThinkingOn(page);
        assert.strictEqual(res, 'already-on');
        assert.strictEqual(clicked, false, 'must not click when already active');
    });

    await test('Thinking: off (aria-checked=false) clicks and flips to true', async () => {
        delete process.env.AGENTCHAT_CLAUDE_NO_THINK;
        const page = createMockPage(`
            <button class="model-select">Sonnet 5</button>
            <div id="portal-root">
                <div role="menuitem">Effort</div>
                <div role="menuitemcheckbox" aria-checked="false">Thinking Can think for more complex tasks</div>
            </div>
        `);
        let clicked = false;
        const item = page.document.querySelector('[role="menuitemcheckbox"]');
        item.addEventListener('click', () => {
            clicked = true;
            item.setAttribute('aria-checked', 'true');
        });

        const res = await claude._ensureClaudeThinkingOn(page);
        assert.strictEqual(res, 'clicked');
        assert.strictEqual(clicked, true, 'must click to enable');
        assert.strictEqual(item.getAttribute('aria-checked'), 'true');
    });

    await test('Thinking: opt-out env skips DOM evaluation', async () => {
        process.env.AGENTCHAT_CLAUDE_NO_THINK = '1';
        try {
            const page = {
                locator: () => { throw new Error('DOM locator must not be called when opt-out is set'); },
            };
            const res = await claude._ensureClaudeThinkingOn(page);
            assert.strictEqual(res, 'skipped');
        } finally {
            delete process.env.AGENTCHAT_CLAUDE_NO_THINK;
        }
    });

    // ── Effort level tests ──

    await test('Effort: env unset is a safe no-op', async () => {
        delete process.env.AGENTCHAT_CLAUDE_EFFORT;
        const page = {
            locator: () => { throw new Error('DOM locator must not be called when effort env is unset'); },
        };
        const res = await claude._ensureClaudeEffort(page);
        assert.strictEqual(res, 'skipped');
    });

    await test('Effort: AGENTCHAT_CLAUDE_EFFORT=high clicks High radio and never Extra/Max', async () => {
        process.env.AGENTCHAT_CLAUDE_EFFORT = 'high';
        try {
            const page = createMockPage(`
                <button class="model-select">Sonnet 5</button>
                <div id="portal-root">
                    <div role="menuitem">Effort</div>
                    <div role="menuitemradio" id="rad-low" aria-checked="false">Low</div>
                    <div role="menuitemradio" id="rad-med" aria-checked="true">Medium (Default)</div>
                    <div role="menuitemradio" id="rad-high" aria-checked="false">High</div>
                    <div role="menuitemradio" id="rad-extra" aria-checked="false">Extra (3.5x usage)</div>
                    <div role="menuitemradio" id="rad-max" aria-checked="false">Max (3.5x usage)</div>
                </div>
            `);
            let clickedHigh = false;
            let clickedForbidden = false;
            page.document.getElementById('rad-high').addEventListener('click', () => {
                clickedHigh = true;
                page.document.getElementById('rad-high').setAttribute('aria-checked', 'true');
            });
            page.document.getElementById('rad-extra').addEventListener('click', () => { clickedForbidden = true; });
            page.document.getElementById('rad-max').addEventListener('click', () => { clickedForbidden = true; });

            const res = await claude._ensureClaudeEffort(page);
            assert.strictEqual(res, 'clicked');
            assert.strictEqual(clickedHigh, true, 'High radio must be clicked');
            assert.strictEqual(clickedForbidden, false, 'Extra and Max must NEVER be clicked');
        } finally {
            delete process.env.AGENTCHAT_CLAUDE_EFFORT;
        }
    });

    await test('Effort: already on target level is already-on', async () => {
        process.env.AGENTCHAT_CLAUDE_EFFORT = 'medium';
        try {
            const page = createMockPage(`
                <button class="model-select">Sonnet 5</button>
                <div id="portal-root">
                    <div role="menuitem">Effort</div>
                    <div role="menuitemradio" id="rad-med" aria-checked="true">Medium (Default)</div>
                </div>
            `);
            let clicked = false;
            page.document.getElementById('rad-med').addEventListener('click', () => { clicked = true; });

            const res = await claude._ensureClaudeEffort(page);
            assert.strictEqual(res, 'already-on');
            assert.strictEqual(clicked, false);
        } finally {
            delete process.env.AGENTCHAT_CLAUDE_EFFORT;
        }
    });

    // ── Deep research tests ──

    await test('Deep research: inert without env', async () => {
        delete process.env.AGENTCHAT_CLAUDE_DEEP_RESEARCH;
        delete process.env.AGENTCHAT_DEEP_RESEARCH;
        const page = {
            locator: () => { throw new Error('DOM locator must not be called when DR is inactive'); },
        };
        const res = await claude._ensureClaudeResearchOn(page);
        assert.strictEqual(res, 'skipped');
    });

    await test('Deep research: missing row logs missing when env active', async () => {
        process.env.AGENTCHAT_CLAUDE_DEEP_RESEARCH = '1';
        try {
            const page = createMockPage(`
                <button aria-label="Add files and more">+</button>
                <div id="portal-root">
                    <div role="menuitem">Web search</div>
                </div>
            `);
            const res = await claude._ensureClaudeResearchOn(page);
            assert.strictEqual(res, 'missing');
        } finally {
            delete process.env.AGENTCHAT_CLAUDE_DEEP_RESEARCH;
        }
    });

    await test('Deep research: clicks row when env active and present', async () => {
        process.env.AGENTCHAT_CLAUDE_DEEP_RESEARCH = '1';
        try {
            const page = createMockPage(`
                <button aria-label="Add files and more">+</button>
                <div id="portal-root">
                    <div role="menuitemcheckbox" aria-checked="false">Deep Research</div>
                </div>
            `);
            let clicked = false;
            page.document.querySelector('[role="menuitemcheckbox"]').addEventListener('click', () => {
                clicked = true;
            });

            const res = await claude._ensureClaudeResearchOn(page);
            assert.strictEqual(res, 'clicked');
            assert.strictEqual(clicked, true);
        } finally {
            delete process.env.AGENTCHAT_CLAUDE_DEEP_RESEARCH;
        }
    });

    // ── providerTimeoutOverride tests ──

    await test('providerTimeoutOverride: returns 1800000 with DR env, undefined without', () => {
        delete process.env.AGENTCHAT_CLAUDE_DEEP_RESEARCH;
        delete process.env.AGENTCHAT_DEEP_RESEARCH;
        assert.strictEqual(claude.providerTimeoutOverride(), undefined);

        process.env.AGENTCHAT_CLAUDE_DEEP_RESEARCH = '1';
        try {
            assert.strictEqual(claude.providerTimeoutOverride(), 1_800_000);
        } finally {
            delete process.env.AGENTCHAT_CLAUDE_DEEP_RESEARCH;
        }

        process.env.AGENTCHAT_DEEP_RESEARCH = '1';
        try {
            assert.strictEqual(claude.providerTimeoutOverride(), 1_800_000);
        } finally {
            delete process.env.AGENTCHAT_DEEP_RESEARCH;
        }
    });

    // ── closeMenusAndWait helper test ──

    await test('closeMenusAndWait cleans up data-base-ui-inert overlay with Escape', async () => {
        const page = createMockPage(`
            <div id="portal-root">
                <div data-base-ui-inert="true"></div>
            </div>
        `);
        assert.ok(page.document.querySelector('#portal-root [data-base-ui-inert]'));
        await claude._closeMenusAndWait(page);
        assert.strictEqual(page.document.querySelector('#portal-root [data-base-ui-inert]'), null);
    });

    // ── preInputHook resilience test ──

    await test('preInputHook wires all steps and handles dead page gracefully', async () => {
        const deadPage = {
            locator: () => ({
                first: () => ({
                    isVisible: async () => { throw new Error('Target closed'); },
                    click: async () => { throw new Error('Target closed'); },
                }),
                last: () => ({
                    isVisible: async () => { throw new Error('Target closed'); },
                    click: async () => { throw new Error('Target closed'); },
                }),
            }),
            evaluate: async () => { throw new Error('Target closed'); },
            keyboard: { press: async () => { throw new Error('Target closed'); } },
        };
        // Must not throw
        await claude.preInputHook(deadPage);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
})();
