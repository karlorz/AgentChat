#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '../../..');
const kimiPath = path.join(ROOT, 'skills/lib/providers/adapters/kimi.js');
const kimi = require(kimiPath);

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

function makePage(html) {
    const dom = new JSDOM(html, { pretendToBeVisual: true });
    const doc = dom.window.document;
    return {
        dom,
        document: doc,
        page: {
            evaluate: async (fn, ...args) => {
                const gDoc = global.document;
                const gWin = global.window;
                global.document = doc;
                global.window = dom.window;
                try {
                    return await fn(...args);
                } finally {
                    global.document = gDoc;
                    global.window = gWin;
                }
            },
            waitForTimeout: async () => {},
            keyboard: { press: async () => {} },
        },
    };
}

(async () => {
    console.log('── Kimi mode dropdown (Instant / K3 / K3 Swarm) ──');

    await test('ensureKimiMode selects Instant by default against a jsdom fixture', async () => {
        delete process.env.AGENTCHAT_KIMI_MODE;
        const html = `
            <div class="composer">
                <button class="mode-select">K3</button>
                <div class="dropdown-menu" style="display:none">
                    <div class="dropdown-item" id="opt-instant">Instant Fast chat, quick replies</div>
                    <div class="dropdown-item" id="opt-k3">K3 Chat & Agent, flagship all-rounder</div>
                    <div class="dropdown-item" id="opt-k3-swarm">K3 Swarm Massive search, batch processing, and more in one go</div>
                    <div class="dropdown-item" id="opt-effort">Thinking effort</div>
                </div>
            </div>
        `;
        const { document: doc, page } = makePage(html);
        const trigger = doc.querySelector('.mode-select');
        const menu = doc.querySelector('.dropdown-menu');
        const optInstant = doc.querySelector('#opt-instant');

        let triggerClicked = false;
        let instantClicked = false;

        trigger.addEventListener('click', () => {
            triggerClicked = true;
            menu.style.display = 'block';
        });

        optInstant.addEventListener('click', () => {
            instantClicked = true;
            trigger.textContent = 'Instant High';
            menu.style.display = 'none';
        });

        const ok = await kimi._ensureKimiMode(page);
        assert.strictEqual(ok, true, 'must return true on successful switch');
        assert.strictEqual(triggerClicked, true, 'trigger must be clicked');
        assert.strictEqual(instantClicked, true, 'Instant option must be clicked');
        assert.strictEqual(trigger.textContent, 'Instant High');
    });

    await test('already-Instant is a no-op (no clicks)', async () => {
        delete process.env.AGENTCHAT_KIMI_MODE;
        const html = `
            <div class="composer">
                <button class="mode-select">Instant High</button>
                <div class="dropdown-menu" style="display:none">
                    <div class="dropdown-item" id="opt-instant">Instant Fast chat, quick replies</div>
                </div>
            </div>
        `;
        const { document: doc, page } = makePage(html);
        const trigger = doc.querySelector('.mode-select');
        const optInstant = doc.querySelector('#opt-instant');

        let clicked = false;
        trigger.addEventListener('click', () => { clicked = true; });
        optInstant.addEventListener('click', () => { clicked = true; });

        const ok = await kimi._ensureKimiMode(page);
        assert.strictEqual(ok, true, 'already-Instant must return true');
        assert.strictEqual(clicked, false, 'no clicks should occur when already on target');
    });

    await test('AGENTCHAT_KIMI_MODE=k3-swarm picks K3 Swarm and never plain K3 (label-regex precision)', async () => {
        process.env.AGENTCHAT_KIMI_MODE = 'k3-swarm';
        try {
            const html = `
                <div class="composer">
                    <button class="mode-select">Instant High</button>
                    <div class="dropdown-menu" style="display:none">
                        <div class="dropdown-item" id="opt-instant">Instant Fast chat, quick replies</div>
                        <div class="dropdown-item" id="opt-k3">K3 Chat & Agent, flagship all-rounder</div>
                        <div class="dropdown-item" id="opt-k3-swarm">K3 Swarm Massive search, batch processing, and more in one go</div>
                    </div>
                </div>
            `;
            const { document: doc, page } = makePage(html);
            const trigger = doc.querySelector('.mode-select');
            const menu = doc.querySelector('.dropdown-menu');
            const optK3 = doc.querySelector('#opt-k3');
            const optK3Swarm = doc.querySelector('#opt-k3-swarm');

            let k3Clicked = false;
            let k3SwarmClicked = false;

            trigger.addEventListener('click', () => { menu.style.display = 'block'; });
            optK3.addEventListener('click', () => {
                k3Clicked = true;
                trigger.textContent = 'K3';
            });
            optK3Swarm.addEventListener('click', () => {
                k3SwarmClicked = true;
                trigger.textContent = 'K3 Swarm';
            });

            const ok = await kimi._ensureKimiMode(page);
            assert.strictEqual(ok, true, 'switch to k3-swarm must succeed');
            assert.strictEqual(k3SwarmClicked, true, 'K3 Swarm must be clicked');
            assert.strictEqual(k3Clicked, false, 'plain K3 must NOT be clicked');
            assert.strictEqual(trigger.textContent, 'K3 Swarm');
        } finally {
            delete process.env.AGENTCHAT_KIMI_MODE;
        }
    });

    await test('missing trigger returns false without throwing', async () => {
        const { page } = makePage('<div class="empty"></div>');
        const ok = await kimi._ensureKimiMode(page);
        assert.strictEqual(ok, false, 'missing trigger must return false');

        const deadPage = {
            evaluate: async () => { throw new Error('Target closed'); },
        };
        const deadOk = await kimi._ensureKimiMode(deadPage);
        assert.strictEqual(deadOk, false, 'dead page must return false without throwing');
    });

    console.log('── Kimi Thinking effort (High / Standard) ──');

    await test('ensureKimiThinkingEffort: default targets High', async () => {
        delete process.env.AGENTCHAT_KIMI_NO_THINK;
        const html = `
            <div class="composer">
                <button class="mode-select">Instant Standard</button>
                <div class="dropdown-menu" style="display:none">
                    <div class="dropdown-item" id="opt-effort">Thinking effort</div>
                    <div class="submenu" id="effort-submenu" style="display:none">
                        <div class="dropdown-item" id="effort-high">High</div>
                        <div class="dropdown-item" id="effort-standard">Standard</div>
                    </div>
                </div>
            </div>
        `;
        const { document: doc, page } = makePage(html);
        const trigger = doc.querySelector('.mode-select');
        const menu = doc.querySelector('.dropdown-menu');
        const optEffort = doc.querySelector('#opt-effort');
        const subMenu = doc.querySelector('#effort-submenu');
        const optHigh = doc.querySelector('#effort-high');
        const optStandard = doc.querySelector('#effort-standard');

        let effortMenuClicked = false;
        let highClicked = false;
        let standardClicked = false;

        trigger.addEventListener('click', () => { menu.style.display = 'block'; });
        optEffort.addEventListener('click', () => {
            effortMenuClicked = true;
            subMenu.style.display = 'block';
        });
        optHigh.addEventListener('click', () => {
            highClicked = true;
            trigger.textContent = 'Instant High';
        });
        optStandard.addEventListener('click', () => {
            standardClicked = true;
            trigger.textContent = 'Instant Standard';
        });

        const ok = await kimi._ensureKimiThinkingEffort(page);
        assert.strictEqual(ok, true, 'must succeed setting High');
        assert.strictEqual(effortMenuClicked, true, 'Thinking effort menu must be clicked');
        assert.strictEqual(highClicked, true, 'High effort item must be clicked');
        assert.strictEqual(standardClicked, false, 'Standard effort must not be clicked');
        assert.strictEqual(trigger.textContent, 'Instant High');
    });

    await test('AGENTCHAT_KIMI_NO_THINK=1 targets Standard', async () => {
        process.env.AGENTCHAT_KIMI_NO_THINK = '1';
        try {
            const html = `
                <div class="composer">
                    <button class="mode-select">Instant High</button>
                    <div class="dropdown-menu" style="display:none">
                        <div class="dropdown-item" id="opt-effort">Thinking effort</div>
                        <div class="submenu" id="effort-submenu" style="display:none">
                            <div class="dropdown-item" id="effort-high">High</div>
                            <div class="dropdown-item" id="effort-standard">Standard</div>
                        </div>
                    </div>
                </div>
            `;
            const { document: doc, page } = makePage(html);
            const trigger = doc.querySelector('.mode-select');
            const menu = doc.querySelector('.dropdown-menu');
            const optEffort = doc.querySelector('#opt-effort');
            const subMenu = doc.querySelector('#effort-submenu');
            const optHigh = doc.querySelector('#effort-high');
            const optStandard = doc.querySelector('#effort-standard');

            let highClicked = false;
            let standardClicked = false;

            trigger.addEventListener('click', () => { menu.style.display = 'block'; });
            optEffort.addEventListener('click', () => { subMenu.style.display = 'block'; });
            optHigh.addEventListener('click', () => {
                highClicked = true;
                trigger.textContent = 'Instant High';
            });
            optStandard.addEventListener('click', () => {
                standardClicked = true;
                trigger.textContent = 'Instant Standard';
            });

            const ok = await kimi._ensureKimiThinkingEffort(page);
            assert.strictEqual(ok, true, 'must succeed setting Standard');
            assert.strictEqual(standardClicked, true, 'Standard must be clicked');
            assert.strictEqual(highClicked, false, 'High must not be clicked');
            assert.strictEqual(trigger.textContent, 'Instant Standard');
        } finally {
            delete process.env.AGENTCHAT_KIMI_NO_THINK;
        }
    });

    await test('missing submenu returns false', async () => {
        const html = `
            <div class="composer">
                <button class="mode-select">Instant</button>
                <div class="dropdown-menu" style="display:none">
                    <div class="dropdown-item">Only Mode Item</div>
                </div>
            </div>
        `;
        const { document: doc, page } = makePage(html);
        const trigger = doc.querySelector('.mode-select');
        trigger.addEventListener('click', () => {
            doc.querySelector('.dropdown-menu').style.display = 'block';
        });

        const ok = await kimi._ensureKimiThinkingEffort(page);
        assert.strictEqual(ok, false, 'missing submenu must return false');
    });

    console.log('── Deep Research opt-in & providerTimeoutOverride ──');

    await test('DR env set → sidebar Deep Research clicked and mode steps skipped', async () => {
        process.env.AGENTCHAT_KIMI_DEEP_RESEARCH = '1';
        try {
            const html = `
                <div class="sidebar">
                    <button class="new-chat-btn">New Chat</button>
                    <button class="deep-research-item">Deep Research</button>
                </div>
                <div class="composer">
                    <button class="mode-select">Instant High</button>
                </div>
            `;
            const { document: doc, page } = makePage(html);
            const drBtn = doc.querySelector('.deep-research-item');
            const newChatBtn = doc.querySelector('.new-chat-btn');
            const modeTrigger = doc.querySelector('.mode-select');

            let drClicked = false;
            let newChatClicked = false;
            let modeTriggerClicked = false;

            drBtn.addEventListener('click', () => { drClicked = true; });
            newChatBtn.addEventListener('click', () => { newChatClicked = true; });
            modeTrigger.addEventListener('click', () => { modeTriggerClicked = true; });

            await kimi.preInputHook(page);
            assert.strictEqual(drClicked, true, 'Deep Research entry must be clicked');
            assert.strictEqual(newChatClicked, false, 'New Chat must NOT be clicked in DR mode');
            assert.strictEqual(modeTriggerClicked, false, 'Mode trigger must NOT be touched in DR mode');
        } finally {
            delete process.env.AGENTCHAT_KIMI_DEEP_RESEARCH;
        }
    });

    await test('DR env unset → no DR click, standard New Chat clicked', async () => {
        delete process.env.AGENTCHAT_KIMI_DEEP_RESEARCH;
        delete process.env.AGENTCHAT_DEEP_RESEARCH;
        const html = `
            <div class="sidebar">
                <button class="new-chat-btn">New Chat</button>
                <button class="deep-research-item">Deep Research</button>
            </div>
            <div class="composer">
                <button class="mode-select">Instant High</button>
            </div>
        `;
        const { document: doc, page } = makePage(html);
        const drBtn = doc.querySelector('.deep-research-item');
        const newChatBtn = doc.querySelector('.new-chat-btn');

        let drClicked = false;
        let newChatClicked = false;

        drBtn.addEventListener('click', () => { drClicked = true; });
        newChatBtn.addEventListener('click', () => { newChatClicked = true; });

        await kimi.preInputHook(page);
        assert.strictEqual(drClicked, false, 'Deep Research entry must NOT be clicked when env unset');
        assert.strictEqual(newChatClicked, true, 'New Chat must be clicked');
    });

    await test('providerTimeoutOverride returns 1800000 with DR env, undefined without', () => {
        delete process.env.AGENTCHAT_KIMI_DEEP_RESEARCH;
        delete process.env.AGENTCHAT_DEEP_RESEARCH;

        assert.strictEqual(typeof kimi.providerTimeoutOverride, 'function');
        assert.strictEqual(kimi.providerTimeoutOverride(), undefined, 'must be undefined without DR');

        process.env.AGENTCHAT_KIMI_DEEP_RESEARCH = '1';
        try {
            assert.strictEqual(kimi.providerTimeoutOverride(), 1_800_000, 'must be 1800000 with AGENTCHAT_KIMI_DEEP_RESEARCH=1');
        } finally {
            delete process.env.AGENTCHAT_KIMI_DEEP_RESEARCH;
        }

        process.env.AGENTCHAT_DEEP_RESEARCH = '1';
        try {
            assert.strictEqual(kimi.providerTimeoutOverride(), 1_800_000, 'must be 1800000 with AGENTCHAT_DEEP_RESEARCH=1');
        } finally {
            delete process.env.AGENTCHAT_DEEP_RESEARCH;
        }
    });

    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
})();
