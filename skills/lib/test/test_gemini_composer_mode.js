#!/usr/bin/env node
'use strict';

/**
 * Regression tests for Gemini composer Chat vs Task chips.
 *
 * Default AGENTCHAT_GEMINI_COMPOSER_MODE is task (任務). Chat is opt-in.
 * Proof is an exclusive selected member of the 對話/任務 pair — not a
 * rotting CSS identity, and not a plaintext @ mention.
 */

const fs = require('fs');
const path = require('path');

const {
    resolveGeminiComposerMode,
    isKnownComposerMode,
    classifyComposerChipText,
    isComposerChipSelected,
    isVerifiedComposerMode,
    ensureComposerMode,
    locales,
} = require('../geminiComposerMode');

const adapterPath = path.join(__dirname, '..', 'providers', 'adapters', 'gemini.js');
const adapterSource = fs.readFileSync(adapterPath, 'utf8');
const composerSource = fs.readFileSync(path.join(__dirname, '..', 'geminiComposerMode.js'), 'utf8');

let pass = 0;
let fail = 0;
function assert(name, actual, expected = true) {
    if (actual === expected) {
        pass++;
        console.log('PASS', name);
    } else {
        fail++;
        console.log('FAIL', name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

async function test(name, fn) {
    try {
        await fn();
        pass++;
        console.log('PASS', name);
    } catch (e) {
        fail++;
        console.log('FAIL', name, e.message);
    }
}

function livePairChips(selected /* 'chat' | 'task' */) {
    const active = selected === 'task' ? 1 : 0;
    return [
        {
            kind: 'chat', text: '對話', indexInGroup: 0, groupActiveIndex: active,
            ancestorClass: selected === 'chat'
                ? 'gem-segmented-button gem-segmented-button-selected'
                : 'gem-segmented-button',
        },
        {
            kind: 'task', text: '任務', indexInGroup: 1, groupActiveIndex: active,
            ancestorClass: selected === 'task'
                ? 'gem-segmented-button gem-segmented-button-selected'
                : 'gem-segmented-button',
        },
    ];
}

function makeChipPage({ initial, afterClick } = {}) {
    let chips = initial || [];
    return {
        page: {
            evaluate: async (fn, arg) => {
                if (arg && Array.isArray(arg.chatLabels)) return chips;
                if (arg && arg.want && afterClick) {
                    chips = afterClick;
                    return true;
                }
                return [];
            },
            locator: () => ({
                first: () => ({
                    click: async () => {
                        if (afterClick) chips = afterClick;
                    },
                }),
            }),
            waitForTimeout: async () => {},
        },
    };
}

console.log('T0: AGENTCHAT_GEMINI_COMPOSER_MODE routing (default task, chat opt-in)');
assert('unset maps to task', resolveGeminiComposerMode(undefined), 'task');
assert('empty maps to task', resolveGeminiComposerMode(''), 'task');
assert('task stays task', resolveGeminiComposerMode('task'), 'task');
assert('TASK aliases to task', resolveGeminiComposerMode('TASK'), 'task');
assert('default aliases to task', resolveGeminiComposerMode('default'), 'task');
assert('chat is explicit opt-in', resolveGeminiComposerMode('chat'), 'chat');
assert('CHAT aliases to chat', resolveGeminiComposerMode('CHAT'), 'chat');
assert('unknown spark is not silently task', resolveGeminiComposerMode('spark'), 'spark');
assert('task is a known mode', isKnownComposerMode('task'));
assert('chat is a known mode', isKnownComposerMode('chat'));
assert('spark is not a known mode', isKnownComposerMode('spark'), false);

console.log('\nT1: chip text (live zh-TW 對話/任務; never 新對話)');
assert('classifies live 對話 as chat', classifyComposerChipText('對話'), 'chat');
assert('classifies live 任務 as task', classifyComposerChipText('任務'), 'task');
assert('classifies zh_CN 对话 as chat', classifyComposerChipText('对话'), 'chat');
assert('classifies zh_CN 任务 as task', classifyComposerChipText('任务'), 'task');
assert('classifies English Chat', classifyComposerChipText('Chat'), 'chat');
assert('classifies English Task', classifyComposerChipText('Task'), 'task');
assert('classifies Japanese チャット as chat', classifyComposerChipText('チャット'), 'chat');
assert('classifies Japanese タスク as task', classifyComposerChipText('タスク'), 'task');
assert('rejects 新對話', classifyComposerChipText('新對話'), null);
assert('rejects 新对话', classifyComposerChipText('新对话'), null);
assert('rejects New chat', classifyComposerChipText('New chat'), null);
assert('rejects 暫時對話', classifyComposerChipText('暫時對話'), null);
assert('rejects 搜尋對話', classifyComposerChipText('搜尋對話'), null);
assert('rejects empty', classifyComposerChipText(''), null);
assert('rejects long sidebar title', classifyComposerChipText('WebCodex MCP Connection Status Check'), null);

console.log('\nT2: selected-state hints (ancestor selected class + group index)');
assert('ancestor gem-segmented-button-selected counts', isComposerChipSelected({
    kind: 'task', ancestorClass: 'gem-segmented-button gem-segmented-button-selected gem-segmented-button-size-small',
}));
assert('unselected ancestor does not count', isComposerChipSelected({
    kind: 'chat', ancestorClass: 'gem-segmented-button gem-segmented-button-size-small',
}), false);
assert('groupActiveIndex 1 matches task index 1', isComposerChipSelected({
    kind: 'task', indexInGroup: 1, groupActiveIndex: 1,
}));
assert('groupActiveIndex 1 does not select chat index 0', isComposerChipSelected({
    kind: 'chat', indexInGroup: 0, groupActiveIndex: 1,
}), false);
assert('aria-pressed=true counts', isComposerChipSelected({
    kind: 'task', ariaPressed: 'true',
}));
assert('aria-pressed=false does not count', isComposerChipSelected({
    kind: 'task', ariaPressed: 'false',
}), false);

console.log('\nT3: exclusive pair is required');
const liveTaskOn = livePairChips('task');
assert('live 2026-10-15 任務 selected is verified task', isVerifiedComposerMode(liveTaskOn, 'task'));
assert('live 任務 selected is not verified chat', isVerifiedComposerMode(liveTaskOn, 'chat'), false);

const liveChatOn = livePairChips('chat');
assert('對話 selected is verified chat', isVerifiedComposerMode(liveChatOn, 'chat'));
assert('對話 selected is not verified task', isVerifiedComposerMode(liveChatOn, 'task'), false);

const missingTask = isVerifiedComposerMode([
    { kind: 'chat', text: '對話', ancestorClass: 'selected' },
], 'task');
assert('missing task chip cannot verify', missingTask, false);
assert('unknown mode cannot verify', isVerifiedComposerMode(liveTaskOn, 'spark'), false);
const neitherOn = isVerifiedComposerMode([
    { kind: 'chat', text: '對話', ancestorClass: '' },
    { kind: 'task', text: '任務', ancestorClass: '' },
], 'task');
assert('neither selected cannot verify', neitherOn, false);
const bothOn = isVerifiedComposerMode([
    { kind: 'chat', text: '對話', ancestorClass: 'selected' },
    { kind: 'task', text: '任務', ancestorClass: 'selected' },
], 'task');
assert('both selected cannot verify', bothOn, false);

console.log('\nT4: locales cover zh_CN / zh_TW / en / ja');
assert('zh_CN chat is 对话', locales.PROFILES.zh_CN.composerChat, '对话');
assert('zh_CN task is 任务', locales.PROFILES.zh_CN.composerTask, '任务');
assert('zh_TW chat is 對話', locales.PROFILES.zh_TW.composerChat, '對話');
assert('zh_TW task is 任務', locales.PROFILES.zh_TW.composerTask, '任務');
assert('en chat is Chat', locales.PROFILES.en.composerChat, 'Chat');
assert('en task is Task', locales.PROFILES.en.composerTask, 'Task');
assert('ja chat is チャット', locales.PROFILES.ja.composerChat, 'チャット');
assert('ja task is タスク', locales.PROFILES.ja.composerTask, 'タスク');

console.log('\nT5: adapter wires ensure after model verify and fail-closes');
assert('adapter requires geminiComposerMode', adapterSource.includes("require('../../geminiComposerMode')"));
assert('adapter calls ensureComposerMode', adapterSource.includes('ensureComposerMode(page, log, composerChoice)'));
assert('adapter calls resolveGeminiComposerMode', adapterSource.includes('resolveGeminiComposerMode()'));
assert('composer runs once after a successful model path',
    (adapterSource.match(/activateComposerOrFail\(\)/g) || []).length === 1
    && adapterSource.includes('return activateComposerOrFail()'));
assert('composer helper is defined inside preInputHook',
    adapterSource.includes('const activateComposerOrFail = async ()'));
assert('composer failure uses ERR_MODEL_DEGRADED',
    adapterSource.includes('Gemini composer mode could not be verified')
    && adapterSource.includes("code: 'ERR_MODEL_DEGRADED'"));
assert('does not pin gem-segmented-button-action as identity',
    !adapterSource.includes('gem-segmented-button-action'));
assert('scan does not pin data-value=40 as Task identity',
    !composerSource.includes('data-value="40"'));

(async () => {
    console.log('\nT6: ensureComposerMode against a live-shaped chip pair');

    await test('already-selected 任務 is idempotent', async () => {
        const { page } = makeChipPage({ initial: livePairChips('task') });
        const logs = [];
        const ok = await ensureComposerMode(page, m => logs.push(m), 'task');
        if (!ok) throw new Error('expected true, logs=' + logs.join(' | '));
        if (!logs.some(l => /already task/.test(l))) throw new Error('expected already-task log, got ' + logs.join(' | '));
    });

    await test('clicks 任務 when 對話 is selected, then verifies', async () => {
        const { page } = makeChipPage({
            initial: livePairChips('chat'),
            afterClick: livePairChips('task'),
        });
        const logs = [];
        const ok = await ensureComposerMode(page, m => logs.push(m), 'task');
        if (!ok) throw new Error('expected true after click, logs=' + logs.join(' | '));
        if (!logs.some(l => /switching composer mode to task/.test(l))) {
            throw new Error('expected switch log, got ' + logs.join(' | '));
        }
    });

    await test('chat opt-in clicks 對話', async () => {
        const { page } = makeChipPage({
            initial: livePairChips('task'),
            afterClick: livePairChips('chat'),
        });
        const ok = await ensureComposerMode(page, () => {}, 'chat');
        if (!ok) throw new Error('expected chat verify true');
    });

    await test('missing chips fail closed', async () => {
        const { page } = makeChipPage({ initial: [] });
        const ok = await ensureComposerMode(page, () => {}, 'task', { budgetMs: 50 });
        if (ok) throw new Error('expected false when chips are absent');
    });

    await test('unknown mode fail closed without requiring chips', async () => {
        const { page } = makeChipPage({ initial: livePairChips('task') });
        const ok = await ensureComposerMode(page, () => {}, 'spark');
        if (ok) throw new Error('expected false for unknown mode');
    });

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
