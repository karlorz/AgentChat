#!/usr/bin/env node
'use strict';

/**
 * Regression tests for the Gemini model picker.
 *
 * The live 2026-08 menu has:
 *   - 3.5 Flash-Lite (available, not target)
 *   - 3.6 Flash (the exact default target)
 *   - 3.1 Pro (may be selected before automation runs)
 *
 * These tests define the invariant: default mode may proceed only after the
 * selected mode is exactly 3.6 Flash and the independently selected Extended
 * Thinking row is present. A generic overlay (such as Upload tools) must
 * never be accepted or cached as the model picker.
 */

const {
    DEFAULT_FLASH_MODEL,
    isDefaultFlashText,
    isDefaultFlashItem,
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

console.log('T1: exact latest Flash target');
assert('target id is 3.6-flash', DEFAULT_FLASH_MODEL.id, '3.6-flash');
assert('accepts 3.6 Flash label', isDefaultFlashText('3.6 Flash 全面協助'));
assert('accepts whitespace-normalized 3.6 Flash', isDefaultFlashText('  3.6   Flash  '));
assert('rejects 3.5 Flash-Lite', isDefaultFlashText('3.5 Flash-Lite 最快答案 新'), false);
assert('rejects 3.6 Flash Lite qualifier', isDefaultFlashText('3.6 Flash Lite'), false);
assert('rejects 3.6 Flash Pro qualifier', isDefaultFlashText('3.6 Flash Pro'), false);
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

console.log('\nT3: selected model must be exactly 3.6 Flash');
assert('reports selected current Pro mode', selectedGeminiModelText(liveModeItems), '3.1 Pro 進階數學和程式碼');
const selected36 = liveModeItems.map(item => ({ ...item, selected: item.text.startsWith('3.6') }));
assert('reports selected 3.6 Flash', selectedGeminiModelText(selected36), '3.6 Flash 全面協助');
assert('selected target passes exact predicate', isDefaultFlashText(selectedGeminiModelText(selected36)));
assert('selected Pro fails exact predicate', isDefaultFlashText(selectedGeminiModelText(liveModeItems)), false);
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

console.log('\nT4: default requires both 3.6 Flash and Extended Thinking');
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
