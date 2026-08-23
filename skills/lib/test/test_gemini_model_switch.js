#!/usr/bin/env node
'use strict';

/**
 * Regression tests for the Gemini model picker.
 *
 * Default Flash is the newest full Flash item actually present in the
 * verified model menu, plus independently selected Extended Thinking.
 * Never Lite/Pro/Ultra, never generic composer "Flash". A literal 3.6 pin
 * is not required: zh_TW (and other locales) may already have retired it.
 *
 * These tests define the invariant: default mode may proceed only after the
 * selected mode is the newest full Flash in that menu and the independently
 * selected Extended Thinking row is present. A generic overlay (such as
 * Upload tools) must never be accepted or cached as the model picker.
 */

const {
    DEFAULT_FLASH_MODEL,
    isDefaultFlashText,
    isDefaultFlashItem,
    pickNewestFullFlash,
    isGeminiModelMenuItems,
    isSelectedGeminiModelItem,
    selectedGeminiModelText,
    isExtendedThinkingText,
    isDefaultFlashExtendedMenuState,
    isProExtendedAria,
    locales,
    _cache,
} = require('../geminiModelSwitch');

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

function pickedText(items) {
    const picked = pickNewestFullFlash(items);
    return picked ? picked.text : null;
}

console.log('T1: full Flash candidates (any version; never Lite/Pro/Ultra)');
assert('default id is not a literal 3.6 pin', DEFAULT_FLASH_MODEL.id !== '3.6-flash');
assert('default id describes newest-full-flash', /newest-full-flash/i.test(DEFAULT_FLASH_MODEL.id));
assert('accepts 3.6 Flash label as a full Flash candidate', isDefaultFlashText('3.6 Flash 全面協助'));
assert('accepts whitespace-normalized 3.6 Flash', isDefaultFlashText('  3.6   Flash  '));
assert('accepts 2.5 Flash as a full Flash candidate', isDefaultFlashText('2.5 Flash'));
assert('accepts 3.7 Flash as a full Flash candidate', isDefaultFlashText('3.7 Flash 全面協助'));
assert('rejects 3.5 Flash-Lite', isDefaultFlashText('3.5 Flash-Lite 最快答案 新'), false);
assert('rejects 3.6 Flash Lite qualifier', isDefaultFlashText('3.6 Flash Lite'), false);
assert('rejects 3.6 Flash Pro qualifier', isDefaultFlashText('3.6 Flash Pro'), false);
assert('rejects 3.6 Flash Ultra qualifier', isDefaultFlashText('3.6 Flash Ultra'), false);
assert('rejects 3.1 Pro', isDefaultFlashText('3.1 Pro 進階數學和程式碼'), false);
assert('rejects generic Flash composer label', isDefaultFlashText('Flash'), false);

console.log('\nT2: menu proof distinguishes mode picker from Upload tools');
const liveModeItems = [
    { text: '3.5 Flash-Lite 最快答案 新', dataModeId: 'cf41', selected: false },
    { text: '3.6 Flash 全面協助', dataModeId: 'fbb1', selected: false },
    { text: '3.1 Pro 進階數學和程式碼', dataModeId: '9d8c', selected: true },
    { text: '延伸思考 解決複雜問題', dataModeId: null, selected: false },
];
assert('recognizes Gemini mode options', isGeminiModelMenuItems(liveModeItems));
assert('rejects arbitrary text overlay', isGeminiModelMenuItems([
    { text: 'Google Drive' }, { text: '上載檔案' },
]), false);
assert('rejects only an Extended Thinking menu item', isGeminiModelMenuItems([
    { text: '延伸思考 解決複雜問題', dataModeId: null },
]), false);

console.log('\nT3: newest full Flash in the live menu wins');
assert('reports selected current Pro mode', selectedGeminiModelText(liveModeItems), '3.1 Pro 進階數學和程式碼');
const selected36 = liveModeItems.map(item => ({ ...item, selected: item.text.startsWith('3.6') }));
assert('reports selected 3.6 Flash', selectedGeminiModelText(selected36), '3.6 Flash 全面協助');
assert('selected 3.6 still counts as a full Flash candidate', isDefaultFlashText(selectedGeminiModelText(selected36)));
assert('selected Pro fails full Flash candidate predicate', isDefaultFlashText(selectedGeminiModelText(liveModeItems)), false);
assert('accepts explicit selected 3.6 item', isDefaultFlashItem({
    text: '3.6 Flash 全面協助', selected: true,
}));
assert('rejects unselected 3.6 item', isDefaultFlashItem({
    text: '3.6 Flash 全面協助', selected: false,
}), false);
assert('reads aria-selected selection evidence', isSelectedGeminiModelItem({
    text: '3.6 Flash 全面協助', ariaSelected: 'true',
}));
assert('reads aria-checked selection evidence', isSelectedGeminiModelItem({
    text: '3.6 Flash 全面協助', ariaChecked: 'true',
}));

assert(
    'fixture Lite + 3.6 Flash + Pro picks 3.6',
    pickedText(liveModeItems),
    '3.6 Flash 全面協助'
);

const menu37 = [
    { text: '3.6 Flash 全面協助', dataModeId: 'fbb1', selected: true },
    { text: '3.7 Flash 全面協助', dataModeId: 'aa77', selected: false },
    { text: '3.1 Pro 進階數學和程式碼', dataModeId: '9d8c', selected: false },
];
assert('fixture 3.7 Flash + 3.6 Flash picks 3.7', pickedText(menu37), '3.7 Flash 全面協助');

const zhTwNo36 = [
    { text: '3.5 Flash-Lite 最快答案 新', dataModeId: 'cf41', selected: false },
    { text: '2.5 Flash', dataModeId: 'a25f', selected: false },
    { text: 'Flash', dataModeId: '', selected: false },
    { text: '3.1 Pro 進階數學和程式碼', dataModeId: '9d8c', selected: true },
    { text: '延伸思考 解決複雜問題', dataModeId: null, selected: false },
];
assert(
    'zh_TW menu missing 3.6 still picks newest full Flash (2.5 Flash)',
    pickedText(zhTwNo36),
    '2.5 Flash'
);
assert('generic Flash in zh_TW menu is not a candidate', isDefaultFlashText('Flash'), false);
assert('zero full Flash candidates returns null', pickedText([
    { text: '3.5 Flash-Lite 最快答案', dataModeId: 'cf41' },
    { text: 'Flash', dataModeId: 'gen' },
    { text: '3.1 Pro 進階數學和程式碼', dataModeId: '9d8c' },
]), null);

console.log('\nT4: default requires newest full Flash AND Extended Thinking');
const flashExtended = [
    { text: '3.5 Flash-Lite 最快答案', dataModeId: 'cf41', selected: false },
    { text: '3.6 Flash 全面協助', dataModeId: 'fbb1', selected: true },
    { text: '3.1 Pro 進階數學和程式碼', dataModeId: '9d8c', selected: false },
    { text: '延伸思考 解決複雜問題', dataModeId: null, selected: true },
];
assert('recognizes localized Extended Thinking item', isExtendedThinkingText('延伸思考 解決複雜問題'));
assert('rejects standard thinking label', isExtendedThinkingText('標準思考'), false);
assert('accepts selected 3.6 Flash + Extended menu state', isDefaultFlashExtendedMenuState(flashExtended));
assert('rejects 3.6 Flash without Extended Thinking', isDefaultFlashExtendedMenuState(
    flashExtended.map(item => ({ ...item, selected: item.text.startsWith('3.6') }))
), false);
assert('rejects Pro + Extended Thinking', isDefaultFlashExtendedMenuState(
    flashExtended.map(item => ({ ...item, selected: item.text.startsWith('3.1') || item.text.startsWith('延伸') }))
), false);
assert('Pro Extended aria requires Pro identity', isProExtendedAria('開模式選擇器，目前係 Pro 延伸思考'));
assert('Pro without Extended Thinking is not Pro Extended', isProExtendedAria('開模式選擇器，目前係 Pro'), false);
assert('Flash Extended aria is not Pro Extended', isProExtendedAria('開模式選擇器，目前係 Flash 延伸思考'), false);
assert('extended selection may be proven by aria-selected', isDefaultFlashExtendedMenuState(
    flashExtended.map(item => item.text.startsWith('延伸')
        ? { ...item, selected: false, ariaSelected: 'true' }
        : item)
));

const zhTwFlashExtended = zhTwNo36.map(item => ({
    ...item,
    selected: item.text.startsWith('2.5') || item.text.startsWith('延伸'),
}));
assert(
    'zh_TW 2.5 Flash + Extended is default even without 3.6',
    isDefaultFlashExtendedMenuState(zhTwFlashExtended)
);
assert(
    'stale 3.6 selection fails when a newer full Flash is in the menu',
    isDefaultFlashExtendedMenuState([
        { text: '3.6 Flash 全面協助', dataModeId: 'fbb1', selected: true },
        { text: '3.7 Flash 全面協助', dataModeId: 'aa77', selected: false },
        { text: '延伸思考 解決複雜問題', dataModeId: null, selected: true },
    ]),
    false
);
assert(
    '3.7 Flash + Extended is default when both 3.7 and 3.6 are present',
    isDefaultFlashExtendedMenuState([
        { text: '3.6 Flash 全面協助', dataModeId: 'fbb1', selected: false },
        { text: '3.7 Flash 全面協助', dataModeId: 'aa77', selected: true },
        { text: '延伸思考 解決複雜問題', dataModeId: null, selected: true },
    ])
);
assert(
    'zero candidates cannot satisfy default even with Extended selected',
    isDefaultFlashExtendedMenuState([
        { text: '3.5 Flash-Lite 最快答案', dataModeId: 'cf41', selected: false },
        { text: 'Flash', dataModeId: 'gen', selected: true },
        { text: '延伸思考 解決複雜問題', dataModeId: null, selected: true },
    ]),
    false
);

console.log('\nT5: zh-TW profile matches the live model-selector aria');
locales.setLocale('zh_TW');
assert('current zh-TW model selector is matched', locales.modelBtnCSS(), 'button[aria-label*="開模式選擇器"]');
assert('fuzzy selector accepts old and current zh-TW wording', locales.FUZZY.modelAria.test('開模式選擇器，目前係 Flash 延伸思考'));
assert('shared locale helper recognizes the current zh-TW aria', locales.inferLocaleFromButtonText('開模式選擇器，目前係 Flash 延伸思考'), 'zh_TW');
assert('shared locale helper keeps Flash Extended out of Pro identity', isProExtendedAria('開模式選擇器，目前係 Flash 延伸思考'), false);
locales.setLocale(null);

console.log('\nT6: legacy selector cache cannot poison default selection');
const oldStateDir = process.env.AGENTCHAT_STATE_DIR;
const os = require('os');
const fs = require('fs');
const path = require('path');
const tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-gemini-cache-'));
try {
    process.env.AGENTCHAT_STATE_DIR = tempStateDir;
    fs.writeFileSync(path.join(tempStateDir, 'gemini-ui-cache.json'), JSON.stringify({
        modelButton: {
            sel: 'button[aria-label*="上載同工具"]',
            tier: 'L0-cache',
            verifiedAt: 1,
        },
    }));
    const migrated = _cache.loadCache();
    assert('discards legacy unproven model button cache', !!migrated.modelButton, false);
    const persisted = JSON.parse(fs.readFileSync(path.join(tempStateDir, 'gemini-ui-cache.json'), 'utf8'));
    assert('removes legacy poisoned selector from disk', !!persisted.modelButton, false);
} finally {
    if (oldStateDir === undefined) delete process.env.AGENTCHAT_STATE_DIR;
    else process.env.AGENTCHAT_STATE_DIR = oldStateDir;
    fs.rmSync(tempStateDir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
