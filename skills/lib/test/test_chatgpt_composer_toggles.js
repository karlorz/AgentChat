#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '../../..');
const chatgptPath = path.join(ROOT, 'skills/lib/providers/adapters/chatgpt.js');
const chatgpt = require(chatgptPath);
const chatgptSrc = fs.readFileSync(chatgptPath, 'utf8');

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

(async () => {
    console.log('── ChatGPT composer Think + Web search ──');

    await test('exports classify + ensure helpers', () => {
        assert.strictEqual(typeof chatgpt.classifyThinkPill, 'function');
        assert.strictEqual(typeof chatgpt.composerHasWebSearchChip, 'function');
        assert.strictEqual(typeof chatgpt.findWebSearchMenuItem, 'function');
        assert.strictEqual(typeof chatgpt._ensureChatgptThinkOn, 'function');
        assert.strictEqual(typeof chatgpt._ensureChatgptWebSearchOn, 'function');
        assert.strictEqual(typeof chatgpt._ensureChatgptDeepResearchOn, 'function');
        assert.strictEqual(typeof chatgpt._isChatgptDeepResearchActive, 'function');
    });

    await test('Think off when aria-pressed=false (live 2026-09-08 free composer)', () => {
        const s = chatgpt.classifyThinkPill({ text: 'Think', ariaPressed: 'false' });
        assert.deepStrictEqual(s, { match: true, on: false, clickable: true });
    });

    await test('Think on when aria-pressed=true — do not click', () => {
        const s = chatgpt.classifyThinkPill({ text: 'Think', ariaPressed: 'true' });
        assert.deepStrictEqual(s, { match: true, on: true, clickable: false });
    });

    await test('Think unknown without aria-pressed — do not click blind', () => {
        const s = chatgpt.classifyThinkPill({ text: 'Think', ariaPressed: null });
        assert.deepStrictEqual(s, { match: true, on: false, clickable: false });
    });

    await test('sidebar Search button is not Think', () => {
        const s = chatgpt.classifyThinkPill({ text: '', ariaLabel: 'Search', ariaPressed: null });
        assert.strictEqual(s.match, false);
    });

    await test('composer chip detects Web search already on', () => {
        const dom = new JSDOM(`<form class="group/composer">
          <div id="prompt-textarea" contenteditable="true">
            <span class="text-token-text-accent">Web search</span>
          </div>
        </form>`);
        assert.strictEqual(chatgpt.composerHasWebSearchChip(dom.window.document), true);
    });

    await test('data-id=search mention pill is the live enabled chip', () => {
        const dom = new JSDOM(`<form><div id="prompt-textarea">
          <span data-inline-selection-pill data-id="search" data-keyword="Web search" data-system-hint-type="search">Web search</span>
        </div></form>`);
        assert.strictEqual(chatgpt.composerHasWebSearchChip(dom.window.document), true);
    });

    await test('typed Web search words are NOT the tool chip', () => {
        const dom = new JSDOM(`<div id="prompt-textarea" contenteditable="true"><p>Web search hello</p></div>`);
        assert.strictEqual(chatgpt.composerHasWebSearchChip(dom.window.document), false);
    });

    await test('empty composer has no Web search chip', () => {
        const dom = new JSDOM(`<form class="group/composer">
          <div id="prompt-textarea" contenteditable="true"><p></p></div>
        </form>`);
        assert.strictEqual(chatgpt.composerHasWebSearchChip(dom.window.document), false);
    });

    await test('plus-menu picks Web search item, not library search', () => {
        const items = [
            { text: 'Add from library Browse and search your files', cls: 'group __menu-item' },
            { text: 'Web search Find real-time news and info', cls: 'group __menu-item' },
            { text: 'Deep research Get a detailed report', cls: 'group __menu-item' },
        ];
        const hit = chatgpt.findWebSearchMenuItem(items);
        assert.ok(hit);
        assert.strictEqual(hit.text, 'Web search Find real-time news and info');
    });

    await test('opt-out env skips Think without evaluating page', async () => {
        process.env.AGENTCHAT_CHATGPT_NO_THINK = '1';
        try {
            const r = await chatgpt._ensureChatgptThinkOn({
                evaluate: () => { throw new Error('must not be called'); },
            });
            assert.strictEqual(r, 'skipped');
        } finally {
            delete process.env.AGENTCHAT_CHATGPT_NO_THINK;
        }
    });

    await test('opt-out env skips Web search without evaluating page', async () => {
        process.env.AGENTCHAT_CHATGPT_NO_WEB_SEARCH = '1';
        try {
            const r = await chatgpt._ensureChatgptWebSearchOn({
                evaluate: () => { throw new Error('must not be called'); },
            });
            assert.strictEqual(r, 'skipped');
        } finally {
            delete process.env.AGENTCHAT_CHATGPT_NO_WEB_SEARCH;
        }
    });

    await test('dead page degrades instead of throwing', async () => {
        const think = await chatgpt._ensureChatgptThinkOn({
            evaluate: async () => { throw new Error('Target closed'); },
        });
        const web = await chatgpt._ensureChatgptWebSearchOn({
            evaluate: async () => { throw new Error('Target closed'); },
            locator: () => ({ first: () => ({ click: async () => { throw new Error('no'); } }) }),
            keyboard: { press: async () => {} },
            waitForTimeout: async () => {},
        });
        assert.strictEqual(think, 'error');
        assert.strictEqual(web, 'error');
    });

    await test('preInputHook source calls both ensure helpers after editor wait', () => {
        assert.ok(/ensureChatgptThinkOn/.test(chatgptSrc), 'Think ensure not wired');
        assert.ok(/ensureChatgptWebSearchOn/.test(chatgptSrc), 'Web search ensure not wired');
    });

    await test('preInputHook adds Web search chip; prompt stays prefix-free', () => {
        const hook = chatgptSrc.slice(chatgptSrc.indexOf('preInputHook:'), chatgptSrc.indexOf('\n    input:'));
        const input = chatgptSrc.slice(chatgptSrc.indexOf('\n    input:'));
        assert.ok(hook.indexOf('ensureChatgptWebSearchOn(page)') < 0,
            'preInputHook must not insert Web search — input does it once');
        assert.ok(hook.indexOf('ensureChatgptThinkOn(page)') < 0,
            'do not click Think in preInputHook — that unwraps the search pill');
        assert.ok(input.indexOf('ensureChatgptWebSearchOn(page)') >= 0,
            'input inserts @Web search once');
        const web = input.indexOf('ensureChatgptWebSearchOn(page)');
        const think = input.indexOf('ensureChatgptThinkOn(page)');
        assert.ok(think > web, 'free ChatGPT Think turns on after @Web search');
    });

    await test('ChatGPT input appends after a search chip instead of wiping the editor', () => {
        const input = chatgptSrc.slice(chatgptSrc.indexOf('\n    input:'));
        assert.ok(/placeCaretAfterComposerChips/.test(input),
            'input must preserve @Web search in front');
        assert.ok(/inputViaKeyboard/.test(input),
            'chip path must append with keyboard, not paste-replace');
        assert.ok(input.indexOf('inputViaSimulatedPaste') < 0,
            'paste-replace wipes the @Web search mention');
    });

    await test('Web search enable types @ then picks the mention, not only the plus button', () => {
        const fn = chatgptSrc.slice(chatgptSrc.indexOf('async function ensureChatgptWebSearchOn'),
            chatgptSrc.indexOf('\nconst adapter'));
        assert.ok(/keyboard\.(type|insertText)\(['"]@['"]\)/.test(fn),
            'must type @ to insert Web search mention');
        assert.ok(!/composer-plus-btn/.test(fn),
            'plus-button fallback duplicates select + typed @Web search');
    });

    // ── Deep Research opt-in & providerTimeoutOverride ──
    await test('DR env gating: inactive without env, active with AGENTCHAT_CHATGPT_DEEP_RESEARCH=1 and AGENTCHAT_DEEP_RESEARCH=1', () => {
        delete process.env.AGENTCHAT_CHATGPT_DEEP_RESEARCH;
        delete process.env.AGENTCHAT_DEEP_RESEARCH;
        assert.strictEqual(chatgpt._isChatgptDeepResearchActive(), false);

        process.env.AGENTCHAT_CHATGPT_DEEP_RESEARCH = '1';
        assert.strictEqual(chatgpt._isChatgptDeepResearchActive(), true);
        delete process.env.AGENTCHAT_CHATGPT_DEEP_RESEARCH;

        process.env.AGENTCHAT_DEEP_RESEARCH = '1';
        assert.strictEqual(chatgpt._isChatgptDeepResearchActive(), true);
        delete process.env.AGENTCHAT_DEEP_RESEARCH;
    });

    await test('providerTimeoutOverride returns 1800000 with DR env, undefined without', () => {
        delete process.env.AGENTCHAT_CHATGPT_DEEP_RESEARCH;
        delete process.env.AGENTCHAT_DEEP_RESEARCH;
        assert.strictEqual(chatgpt.providerTimeoutOverride(), undefined);

        process.env.AGENTCHAT_CHATGPT_DEEP_RESEARCH = '1';
        assert.strictEqual(chatgpt.providerTimeoutOverride(), 1_800_000);
        delete process.env.AGENTCHAT_CHATGPT_DEEP_RESEARCH;

        process.env.AGENTCHAT_DEEP_RESEARCH = '1';
        assert.strictEqual(chatgpt.providerTimeoutOverride(), 1_800_000);
        delete process.env.AGENTCHAT_DEEP_RESEARCH;
    });

    await test('DR clicks the Deep research menu row in a plus-menu fixture', async () => {
        process.env.AGENTCHAT_CHATGPT_DEEP_RESEARCH = '1';
        try {
            const dom = new JSDOM(`
                <form>
                    <div id="prompt-textarea" contenteditable="true"></div>
                    <button aria-label="Add attachment" id="plus-btn">+</button>
                    <div id="menu" style="display:none;">
                        <div class="menu-item" id="web-search-row">Web search</div>
                        <div class="menu-item" id="dr-row">Deep research Get a detailed report</div>
                    </div>
                </form>
            `);
            const doc = dom.window.document;
            let plusClicked = false;
            let rowClicked = false;

            doc.getElementById('plus-btn').onclick = (e) => {
                if (e && e.preventDefault) e.preventDefault();
                plusClicked = true;
                doc.getElementById('menu').style.display = 'block';
            };
            doc.getElementById('plus-btn').addEventListener('click', () => {
                plusClicked = true;
            });

            doc.getElementById('dr-row').onclick = (e) => {
                if (e && e.preventDefault) e.preventDefault();
                rowClicked = true;
                const chip = doc.createElement('span');
                chip.setAttribute('data-system-hint-type', 'deep_research');
                chip.textContent = 'Deep research';
                doc.getElementById('prompt-textarea').appendChild(chip);
            };
            doc.getElementById('dr-row').addEventListener('click', () => {
                rowClicked = true;
                const chip = doc.createElement('span');
                chip.setAttribute('data-system-hint-type', 'deep_research');
                chip.textContent = 'Deep research';
                doc.getElementById('prompt-textarea').appendChild(chip);
            });

            rowClicked = false;
            plusClicked = false;
            doc.getElementById('prompt-textarea').innerHTML = '';

            const fakePage = {
                evaluate: async (fn, ...args) => {
                    const gDoc = global.document;
                    const gWin = global.window;
                    const gMouseEvent = global.MouseEvent;
                    global.document = doc;
                    global.window = dom.window;
                    global.MouseEvent = dom.window.MouseEvent;
                    try {
                        return await fn.call(dom.window, ...args);
                    } finally {
                        global.document = gDoc;
                        global.window = gWin;
                        global.MouseEvent = gMouseEvent;
                    }
                },
                waitForTimeout: async () => {},
            };

            const res = await chatgpt._ensureChatgptDeepResearchOn(fakePage);
            assert.strictEqual(plusClicked, true, 'plus button should be clicked');
            assert.strictEqual(rowClicked, true, 'deep research row should be clicked');
            assert.strictEqual(res, 'clicked');
        } finally {
            delete process.env.AGENTCHAT_CHATGPT_DEEP_RESEARCH;
        }
    });

    await test('DR active skips web search chip step in input orchestration', () => {
        const inputMethod = chatgptSrc.slice(chatgptSrc.indexOf('\n    input:'));
        assert.ok(inputMethod.indexOf('isChatgptDeepResearchActive()') >= 0, 'must check DR active in input()');
        assert.ok(inputMethod.indexOf('ensureChatgptDeepResearchOn(page)') >= 0, 'must call ensureChatgptDeepResearchOn');
        assert.ok(inputMethod.indexOf('ensureChatgptWebSearchOn(page)') >= 0, 'must call ensureChatgptWebSearchOn on else path');
        assert.ok(
            /if\s*\(\s*isChatgptDeepResearchActive\(\)\s*\)\s*\{\s*await ensureChatgptDeepResearchOn\(page\);\s*\}\s*else\s*\{\s*await ensureChatgptWebSearchOn\(page\);\s*\}/.test(inputMethod),
            'DR active must skip ensureChatgptWebSearchOn'
        );
    });

    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
})();
