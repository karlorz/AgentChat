#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '../../..');
const doubao = require(path.join(ROOT, 'skills/lib/providers/adapters/doubao.js'));
const { extractResponse, IN_PAGE_TEXT_WITH_MATH } = require(path.join(ROOT, 'skills/lib/providerFactory.js'));

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

// Build a mock Playwright locator element backed by a jsdom element,
// mirroring how Playwright's el.evaluate(fn, ...args) runs fn in-page.
function makeMockLocator(domElement, win) {
    return {
        evaluate: async (fn, ...args) => {
            const prevDoc = global.document;
            const prevWin = global.window;
            global.document = win.document;
            global.window = win;
            try {
                return await fn(domElement, ...args);
            } finally {
                global.document = prevDoc;
                global.window = prevWin;
            }
        },
    };
}

(async () => {
    console.log('── Doubao response selector and suggest exclusion ──');

    const fixtureHtml = `
    <div class="chat-container">
        <!-- Real conversation list -->
        <div class="message-list-zLoNs1">
            <div class="inner-item-1">
                <div class="user-query">Hello Doubao</div>
            </div>
            <div class="inner-item-2">
                <div class="relative grid w-full grid-cols-[minmax(0,1fr)_auto]">
                    <div class="content">DOUBAO OK: Here is the helpful response.</div>
                </div>
            </div>
            <!-- Suggestion chips wrapper nested inside real message list -->
            <div class="suggest-message-list-wrapper-abc">
                <div class="suggest-list-item">
                    <span class="suggest-list-item-title">你能做些什么？</span>
                </div>
                <div class="suggest-list-item">
                    <span class="suggest-list-item-title">你是谁？</span>
                </div>
                <div class="suggest-list-item">
                    <span class="suggest-list-item-title">你可以回答哪些领域的问题？</span>
                </div>
            </div>
        </div>
    </div>`;

    await test('adapter config declares fixed primary selector and responseExcludeSelectors', () => {
        assert.ok(Array.isArray(doubao.responseSelectors), 'responseSelectors must be an array');
        assert.strictEqual(
            doubao.responseSelectors[0],
            '[class*="message-list"]:not([class*="suggest"])',
            'primary selector must structurally exclude suggest family'
        );
        assert.deepStrictEqual(
            doubao.responseExcludeSelectors,
            ['[class*="suggest"]'],
            'responseExcludeSelectors must exclude suggest family'
        );
    });

    await test('primary selector matches real message list and never the suggest wrapper', () => {
        const dom = new JSDOM(fixtureHtml);
        const doc = dom.window.document;
        const sel = doubao.responseSelectors[0];

        const matches = [...doc.querySelectorAll(sel)];
        assert.strictEqual(matches.length, 1, `expected 1 match, found ${matches.length}`);
        assert.ok(
            matches[0].classList.contains('message-list-zLoNs1'),
            'must match the real message-list container'
        );
        assert.strictEqual(
            matches[0].classList.contains('suggest-message-list-wrapper-abc'),
            false,
            'must never match the suggest wrapper'
        );

        // Prove old unconstrained selector matched BOTH containers
        const oldMatches = [...doc.querySelectorAll('[class*="message-list"]')];
        assert.strictEqual(oldMatches.length, 2, 'unconstrained selector must match both containers');
        assert.ok(
            oldMatches[oldMatches.length - 1].classList.contains('suggest-message-list-wrapper-abc'),
            'old unconstrained selector .last() would have picked the suggest wrapper'
        );
    });

    await test('extractResponse with doubao config returns reply marker and strips suggest chips', async () => {
        const dom = new JSDOM(fixtureHtml);
        const doc = dom.window.document;
        const realListEl = doc.querySelector('.message-list-zLoNs1');
        const mockLocator = makeMockLocator(realListEl, dom.window);

        const text = await extractResponse(null, mockLocator, doubao, 'Hello Doubao');
        assert.ok(text !== null, 'extractResponse must return text');
        assert.ok(text.includes('DOUBAO OK'), 'must contain model reply marker');
        assert.ok(!text.includes('你能做些什么'), 'must not contain chip 1');
        assert.ok(!text.includes('你是谁'), 'must not contain chip 2');
        assert.ok(!text.includes('你可以回答哪些领域'), 'must not contain chip 3');
    });

    await test('without responseExcludeSelectors the real message-list fixture WOULD contain chip text', async () => {
        const dom = new JSDOM(fixtureHtml);
        const doc = dom.window.document;
        const realListEl = doc.querySelector('.message-list-zLoNs1');
        const mockLocator = makeMockLocator(realListEl, dom.window);

        // Config identical to doubao but without responseExcludeSelectors
        const unconfigured = { ...doubao };
        delete unconfigured.responseExcludeSelectors;

        const text = await extractResponse(null, mockLocator, unconfigured, 'Hello Doubao');
        assert.ok(text !== null, 'extractResponse must return text');
        assert.ok(text.includes('DOUBAO OK'), 'contains model reply');
        assert.ok(text.includes('你能做些什么'), 'without exclusions, child chip text leaks into response');
        assert.ok(text.includes('你是谁'), 'without exclusions, child chip text leaks into response');
    });

    await test('extractResponse with no responseExcludeSelectors configured behaves identically to before', async () => {
        const dom = new JSDOM(`
            <div class="message-content">
                <p>Standard response without any exclusions.</p>
                <div class="katex"><annotation encoding="application/x-tex">E=mc^2</annotation></div>
            </div>
        `);
        const doc = dom.window.document;
        const el = doc.querySelector('.message-content');
        const mockLocator = makeMockLocator(el, dom.window);

        const configNoExcludes = { key: 'generic', minResponseLength: 5 };
        const text = await extractResponse(null, mockLocator, configNoExcludes, 'some prompt');
        assert.ok(text.includes('Standard response without any exclusions.'), 'prose preserved');
        assert.ok(text.includes('$E=mc^2$'), 'KaTeX formula rendered');
    });

    await test('IN_PAGE_TEXT_WITH_MATH backward compatibility when called without excludeSels', () => {
        const dom = new JSDOM(`
            <div class="box">
                <span class="suggest-chip">Chip to keep when unconfigured</span>
                <span class="prose">Keep this text</span>
            </div>
        `);
        const el = dom.window.document.querySelector('.box');
        const prevDoc = global.document;
        global.document = dom.window.document;
        try {
            const textDefault = IN_PAGE_TEXT_WITH_MATH(el);
            assert.ok(textDefault.includes('Chip to keep when unconfigured'), 'keeps chips when no exclude list passed');
            assert.ok(textDefault.includes('Keep this text'), 'keeps prose');

            const textExcluded = IN_PAGE_TEXT_WITH_MATH(el, ['.suggest-chip']);
            assert.ok(!textExcluded.includes('Chip to keep'), 'removes excluded selector nodes');
            assert.ok(textExcluded.includes('Keep this text'), 'preserves remaining content');
        } finally {
            global.document = prevDoc;
        }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
