#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');
const providerFactory = require(path.join(ROOT, 'skills/lib/providerFactory'));
const execute = require(path.join(ROOT, 'skills/lib/execute'));
const oneWeb = require(path.join(ROOT, 'skills/AgentChat-OneWeb/index.js'));
const independent = require(path.join(ROOT, 'skills/AgentChat-IndependentTasks/index.js'));
const webSubAgent = require(path.join(ROOT, 'skills/AgentChat-WebSubAgent/index.js'));

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

function fakePage({ stopVisible = false, texts = ['complete answer'], url = 'https://chatgpt.com/c/test-conversation', gotoDelay = 0 } = {}) {
    let textIndex = 0;
    const seenSelectors = [];
    const page = {
        seenSelectors,
        _url: url,
        url() { return this._url; },
        isClosed() { return false; },
        context() { return null; },
        async goto(next) {
            this._url = next;
            if (gotoDelay > 0) await new Promise(resolve => setTimeout(resolve, gotoDelay));
        },
        async waitForTimeout(ms) {
            assert.ok(Number.isFinite(ms), `waitForTimeout requires a finite duration, got ${ms}`);
            await new Promise(resolve => setTimeout(resolve, Math.min(ms, 2)));
        },
        locator(selector) {
            seenSelectors.push(selector);
            const isStop = /stop-button|aria-label.*Stop/i.test(selector);
            const loc = {
                first() { return this; },
                last() { return this; },
                nth() { return this; },
                async count() { return isStop ? (stopVisible ? 1 : 0) : 1; },
                async waitFor({ state }) {
                    if (isStop && state === 'visible' && !stopVisible) throw new Error('not visible');
                    if (isStop && (state === 'hidden' || state === 'detached') && stopVisible) throw new Error('still visible');
                    return true;
                },
                async isVisible() { return isStop ? stopVisible : true; },
                async evaluate() {
                    if (isStop) return '';
                    const value = texts[Math.min(textIndex, texts.length - 1)];
                    textIndex++;
                    return value;
                },
            };
            return loc;
        },
    };
    return page;
}

const fastConfig = {
    key: 'chatgpt',
    stopSelectors: ['button[data-testid="stop-button"]'],
    responseSelectors: ['[data-message-author-role="assistant"]'],
    responseSelectorTimeout: 5,
    stabilityWindow: 8,
    pollInterval: 2,
    minResponseLength: 5,
    captureImages: false,
    navWaitUntil: 'domcontentloaded',
    navTimeout: 50,
    navPostDelay: 0,
};

(async () => {
    console.log('── quota-safe ChatGPT timeout recovery ──');

    await test('validates only HTTPS chatgpt.com conversation URLs', () => {
        assert.strictEqual(typeof providerFactory.validateChatGptConversationUrl, 'function');
        assert.strictEqual(
            providerFactory.validateChatGptConversationUrl('https://chatgpt.com/c/abc-123'),
            'https://chatgpt.com/c/abc-123'
        );
        for (const bad of [
            'http://chatgpt.com/c/abc',
            'https://evil.example/c/abc',
            'https://user@chatgpt.com/c/abc',
            'https://chatgpt.com/c/abc?share=1',
            'https://chatgpt.com/',
            'https://chatgpt.com/c/',
            'not a url',
        ]) assert.strictEqual(providerFactory.validateChatGptConversationUrl(bad), null, bad);
    });

    await test('visible stop control prevents deadline partial text from completing', async () => {
        const page = fakePage({ stopVisible: true, texts: ['partial answer'] });
        const result = await providerFactory.waitForCompletion(
            page,
            { ...fastConfig, returnObservation: true },
            Date.now(),
            24
        );
        assert.strictEqual(result.status, 'pending');
        assert.strictEqual(result.stopVisible, true);
        assert.ok(result.responseEl, 'partial response element remains available for recovery');
    });

    await test('stable response with no stop control is complete', async () => {
        const page = fakePage({ stopVisible: false, texts: ['finished answer'] });
        const result = await providerFactory.waitForCompletion(
            page,
            { ...fastConfig, returnObservation: true },
            Date.now(),
            80
        );
        assert.strictEqual(result.status, 'complete');
        assert.strictEqual(result.stable, true);
    });

    await test('continuing text mutation at the deadline remains pending', async () => {
        const changing = Array.from({ length: 30 }, (_, i) => 'streaming answer ' + i);
        const page = fakePage({ stopVisible: false, texts: changing });
        const result = await providerFactory.waitForCompletion(
            page,
            { ...fastConfig, returnObservation: true },
            Date.now(),
            24
        );
        assert.strictEqual(result.status, 'pending');
        assert.strictEqual(result.stable, false);
    });

    await test('read-only resume extracts an existing answer without touching the composer', async () => {
        assert.strictEqual(typeof providerFactory.resumeChatGptConversation, 'function');
        const page = fakePage({ stopVisible: false, texts: ['resumed complete answer'] });
        let newPages = 0;
        const context = { async newPage() { newPages++; return page; } };
        const result = await providerFactory.resumeChatGptConversation(
            context,
            'https://chatgpt.com/c/resume-123',
            fastConfig,
            80
        );
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.response, 'resumed complete answer');
        assert.strictEqual(newPages, 1);
        assert.strictEqual(page.url(), 'https://chatgpt.com/c/resume-123');
        assert.ok(!page.seenSelectors.some(s => /prompt-textarea|send-button|contenteditable/i.test(s)),
            'resume must not inspect or operate the composer');
    });

    await test('read-only resume returns pending for active generation without touching the composer', async () => {
        const page = fakePage({ stopVisible: true, texts: ['still generating'] });
        const context = { async newPage() { return page; } };
        const result = await providerFactory.resumeChatGptConversation(
            context,
            'https://chatgpt.com/c/resume-active',
            fastConfig,
            24
        );
        assert.strictEqual(result.pending, true);
        assert.strictEqual(result.safe_to_resend, false);
        assert.ok(!page.seenSelectors.some(s => /prompt-textarea|send-button|contenteditable/i.test(s)));
    });

    await test('read-only resume supplies shared polling defaults for older adapter configs', async () => {
        const page = fakePage({ stopVisible: false, texts: ['completed with normalized defaults'] });
        const context = { async newPage() { return page; } };
        const legacyConfig = { ...fastConfig };
        delete legacyConfig.pollInterval;
        const result = await providerFactory.resumeChatGptConversation(
            context,
            'https://chatgpt.com/c/legacy-adapter',
            legacyConfig,
            40
        );
        assert.strictEqual(result.success, true);
    });

    await test('read-only resume counts navigation against its observation deadline', async () => {
        const page = fakePage({
            stopVisible: false,
            texts: ['answer that would otherwise stabilize'],
            gotoDelay: 24,
        });
        const context = { async newPage() { return page; } };
        const result = await providerFactory.resumeChatGptConversation(
            context,
            'https://chatgpt.com/c/navigation-budget',
            fastConfig,
            20
        );
        assert.strictEqual(result.pending, true);
        assert.strictEqual(result.safe_to_resend, false);
    });

    await test('pending line is machine-readable and omits an unavailable URL', () => {
        assert.strictEqual(typeof oneWeb.formatPendingLine, 'function');
        const withUrl = oneWeb.formatPendingLine({
            provider: 'chatgpt', conversation_url: 'https://chatgpt.com/c/abc'
        });
        assert.match(withUrl, /^\[oneweb\] AGENTCHAT_PENDING /);
        const parsed = JSON.parse(withUrl.slice(withUrl.indexOf('{')));
        assert.deepStrictEqual(parsed, {
            status: 'submitted_pending',
            provider: 'chatgpt',
            conversation_url: 'https://chatgpt.com/c/abc',
            safe_to_resend: false,
        });
        const withoutUrl = JSON.parse(oneWeb.formatPendingLine({ provider: 'chatgpt' }).slice(withUrl.indexOf('{')));
        assert.ok(!Object.prototype.hasOwnProperty.call(withoutUrl, 'conversation_url'));
    });

    await test('OneWeb stops its internal chain on pending and keeps a URL-less recovery tab', async () => {
        assert.strictEqual(typeof oneWeb.tryAllProviders, 'function');
        let chatgptCalls = 0;
        let claudeCalls = 0;
        let closed = false;
        const page = { url: () => 'https://chatgpt.com/', isClosed: () => false, close: async () => { closed = true; } };
        const context = {
            pages: () => [],
            newPage: async () => page,
            grantPermissions: async () => {},
        };
        const browser = { isConnected: () => true, contexts: () => [context] };
        const ctx = { telemetry: { per_provider_ms: {} } };
        const result = await oneWeb.tryAllProviders(browser, 'already submitted', ctx, {
            startFrom: 'chatgpt',
            totalTimeout: 60_000,
            providerTimeout: 20_000,
            runners: {
                chatgpt: async () => { chatgptCalls++; return { pending: true, success: false, provider: 'chatgpt', safe_to_resend: false }; },
                claude: async () => { claudeCalls++; return { success: true, response: 'must not run' }; },
            },
        });
        assert.strictEqual(result.pending, true);
        assert.strictEqual(chatgptCalls, 1);
        assert.strictEqual(claudeCalls, 0);
        assert.strictEqual(closed, false);
    });

    await test('opt-in disabled preserves the legacy completion locator contract', async () => {
        const page = fakePage({ stopVisible: false, texts: ['legacy completed answer'] });
        const result = await providerFactory.waitForCompletion(page, fastConfig, Date.now(), 80);
        assert.ok(result && typeof result.evaluate === 'function');
        assert.strictEqual(result.status, undefined);
    });

    await test('invalid resume URL fails as usage before browser navigation', () => {
        const { spawnSync } = require('child_process');
        const r = spawnSync(process.execPath, [
            path.join(ROOT, 'skills/AgentChat-OneWeb/index.js'),
            '--resume-chatgpt=http://chatgpt.com/c/not-https',
        ], { cwd: ROOT, encoding: 'utf8', timeout: 10_000 });
        assert.strictEqual(r.status, 64);
        assert.match(r.stderr, /invalid ChatGPT conversation URL/i);
        assert.doesNotMatch(r.stderr, /Cannot connect to Chrome CDP/i);
    });

    await test('ChatGPT opt-in doubles only the parent watchdog budget', () => {
        assert.strictEqual(typeof execute._effectiveProcessTimeoutMs, 'function');
        const old = process.env.AGENTCHAT_CHATGPT_RESUME_ON_TIMEOUT;
        process.env.AGENTCHAT_CHATGPT_RESUME_ON_TIMEOUT = '1';
        try {
            assert.strictEqual(execute._effectiveProcessTimeoutMs('chatgpt', 180_000), 360_000);
            assert.strictEqual(execute._effectiveProcessTimeoutMs('claude', 180_000), 180_000);
        } finally {
            if (old === undefined) delete process.env.AGENTCHAT_CHATGPT_RESUME_ON_TIMEOUT;
            else process.env.AGENTCHAT_CHATGPT_RESUME_ON_TIMEOUT = old;
        }
    });

    await test('shared executor stops fallback after a pending ChatGPT submission', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-pending-'));
        try {
            const calls = path.join(tmp, 'calls.log');
            const fixture = path.join(tmp, 'oneweb-fixture.js');
            fs.writeFileSync(fixture, `
                const fs = require('fs');
                const provider = process.argv.find(a => a.startsWith('--only=')).split('=')[1];
                fs.appendFileSync(${JSON.stringify(calls)}, provider + '\\n');
                if (provider === 'chatgpt') {
                    process.stderr.write('[oneweb] AGENTCHAT_PENDING {"status":"submitted_pending","provider":"chatgpt","conversation_url":"https://chatgpt.com/c/pending-1","safe_to_resend":false}\\n');
                    process.exit(10);
                }
                process.stdout.write('fallback answer that must never run\\n');
                process.exit(0);
            `);
            const executor = execute.createExecutor({ webextPath: fixture, minCallBudgetMs: 10_000 });
            const result = await executor.runChain(['chatgpt', 'claude'], 'long request', 60_000);
            assert.strictEqual(result.pending, true);
            assert.strictEqual(result.conversation_url, 'https://chatgpt.com/c/pending-1');
            assert.strictEqual(result.safe_to_resend, false);
            assert.deepStrictEqual(fs.readFileSync(calls, 'utf8').trim().split(/\n/), ['chatgpt']);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    await test('IndependentTasks preserves pending without anchor-format retry', async () => {
        assert.strictEqual(typeof independent.runOneWorker, 'function');
        let calls = 0;
        const pending = {
            success: false,
            pending: true,
            provider_used: 'chatgpt',
            primary_intended: 'chatgpt',
            response: null,
            conversation_url: 'https://chatgpt.com/c/pending-node',
            safe_to_resend: false,
        };
        const result = await independent.runOneWorker(
            { id: 'q1', ai: 'chatgpt', role: 'researcher', prompt: 'question', questions: ['Q1'] },
            60_000,
            [],
            'question',
            async () => { calls++; return pending; }
        );
        assert.strictEqual(calls, 1);
        assert.strictEqual(result.output.pending, true);
        assert.deepStrictEqual(result.quality.issues, ['PENDING']);
    });

    await test('WebSubAgent maps pending stages to timeout exit code 10', () => {
        assert.strictEqual(typeof webSubAgent.resultExitCode, 'function');
        assert.strictEqual(webSubAgent.resultExitCode({ pending: true, success: false }), 10);
        assert.strictEqual(webSubAgent.resultExitCode({ success: true }), 0);
        assert.strictEqual(webSubAgent.resultExitCode({ success: false }), 2);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
