#!/usr/bin/env node
'use strict';

/**
 * Regression tests for the Gemini model picker.
 *
 * Default is the newest Argon item actually present in the verified model
 * menu, plus independently selected high reasoning. Never Lite/Pro/Ultra/
 * Flash/Spark, never generic composer "Argon". A literal 4 pin is not
 * required: the live menu label is the source of truth.
 *
 * These tests define the invariant: default mode may proceed only after the
 * selected mode is the newest Argon in that menu and the independently
 * selected high-reasoning row is present. A generic overlay (such as
 * Upload tools) must never be accepted or cached as the model picker.
 * Composer generic Flash/Argon aria is not proof.
 */

const {
    DEFAULT_ARGON_MODEL,
    DEFAULT_FLASH_MODEL,
    resolveGeminiModelChoice,
    isDefaultArgonText,
    isDefaultArgonItem,
    pickNewestArgon,
    isDefaultArgonHighMenuState,
    isDefaultFlashText,
    isDefaultFlashItem,
    pickNewestFullFlash,
    isGeminiModelMenuItems,
    isSelectedGeminiModelItem,
    selectedGeminiModelText,
    isExtendedThinkingText,
    isHighReasoningText,
    isThinkingParentText,
    isDefaultFlashExtendedMenuState,
    isProExtendedAria,
    inferLocaleFromAria,
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

function pickedArgon(items) {
    const picked = pickNewestArgon(items);
    return picked ? picked.text : null;
}

function pickedFlash(items) {
    const picked = pickNewestFullFlash(items);
    return picked ? picked.text : null;
}

console.log('T0: AGENTCHAT_GEMINI_MODEL routing (legacy flash must not fight Argon)');
assert('unset maps to argon', resolveGeminiModelChoice(undefined), 'argon');
assert('empty maps to argon', resolveGeminiModelChoice(''), 'argon');
assert('argon stays argon', resolveGeminiModelChoice('argon'), 'argon');
assert('legacy flash aliases to argon', resolveGeminiModelChoice('flash'), 'argon');
assert('legacy FLASH aliases to argon', resolveGeminiModelChoice('FLASH'), 'argon');
assert('default aliases to argon', resolveGeminiModelChoice('default'), 'argon');
assert('pro stays pro', resolveGeminiModelChoice('pro'), 'pro');
assert('full-flash stays full-flash opt-in', resolveGeminiModelChoice('full-flash'), 'full-flash');

console.log('\nT1: Argon candidates (any version or unversioned; never Lite/Pro/Ultra/Flash/Spark)');
assert('default id is not a literal 4 pin', DEFAULT_ARGON_MODEL.id !== '4-argon');
assert('default id describes newest-argon', /newest-argon/i.test(DEFAULT_ARGON_MODEL.id));
assert('accepts unversioned Argon menu label', isDefaultArgonText('Argon'));
assert('accepts whitespace-normalized Argon', isDefaultArgonText('  Argon  '));
assert('accepts 4 Argon as an Argon candidate', isDefaultArgonText('4 Argon 深度推理'));
assert('accepts 4.1 Argon as an Argon candidate', isDefaultArgonText('4.1 Argon'));
assert('rejects Argon Lite', isDefaultArgonText('Argon Lite'), false);
assert('rejects Argon Pro qualifier', isDefaultArgonText('Argon Pro'), false);
assert('rejects Flash', isDefaultArgonText('3.8 Flash 全面協助'), false);
assert('rejects generic Flash composer label', isDefaultArgonText('Flash'), false);
assert('rejects Spark', isDefaultArgonText('Spark'), false);
assert('rejects Pro', isDefaultArgonText('3.1 Pro 進階數學和程式碼'), false);

console.log('\nT2: menu proof distinguishes mode picker from Upload tools');
const liveModeItems = [
    { text: '3.5 Flash-Lite 最快答案 新', dataModeId: 'cf41', selected: false },
    { text: '3.8 Flash 全面協助', dataModeId: 'fbb1', selected: false },
    { text: 'Argon', dataModeId: 'argon1', selected: false },
    { text: '3.1 Pro 進階數學和程式碼', dataModeId: '9d8c', selected: true },
    { text: '延伸思考 解決複雜問題', dataModeId: null, selected: false },
];
assert('recognizes Gemini mode options', isGeminiModelMenuItems(liveModeItems));
assert('rejects arbitrary text overlay', isGeminiModelMenuItems([
    { text: 'Google Drive' }, { text: '上載檔案' },
]), false);
assert('rejects only a reasoning menu item', isGeminiModelMenuItems([
    { text: '延伸思考 解決複雜問題', dataModeId: null },
]), false);

console.log('\nT3: newest Argon in the live menu wins');
assert('reports selected current Pro mode', selectedGeminiModelText(liveModeItems), '3.1 Pro 進階數學和程式碼');
const selectedArgon = liveModeItems.map(item => ({ ...item, selected: item.text === 'Argon' }));
assert('reports selected Argon', selectedGeminiModelText(selectedArgon), 'Argon');
assert('selected Argon counts as an Argon candidate', isDefaultArgonText(selectedGeminiModelText(selectedArgon)));
assert('selected Pro fails Argon candidate predicate', isDefaultArgonText(selectedGeminiModelText(liveModeItems)), false);
assert('accepts explicit selected Argon item', isDefaultArgonItem({
    text: 'Argon', selected: true,
}));
assert('rejects unselected Argon item', isDefaultArgonItem({
    text: 'Argon', selected: false,
}), false);
assert('reads aria-selected selection evidence', isSelectedGeminiModelItem({
    text: 'Argon', ariaSelected: 'true',
}));
assert('reads aria-checked selection evidence', isSelectedGeminiModelItem({
    text: 'Argon', ariaChecked: 'true',
}));

assert(
    'fixture Lite + Flash + Argon + Pro picks Argon',
    pickedArgon(liveModeItems),
    'Argon'
);

const menuTwoArgon = [
    { text: '3 Argon', dataModeId: 'a3', selected: true },
    { text: '4 Argon', dataModeId: 'a4', selected: false },
    { text: '3.8 Flash 全面協助', dataModeId: 'fbb1', selected: false },
];
assert('fixture 4 Argon + 3 Argon picks 4', pickedArgon(menuTwoArgon), '4 Argon');

const unversionedAndVersioned = [
    { text: 'Argon', dataModeId: 'a', selected: true },
    { text: '4 Argon', dataModeId: 'a4', selected: false },
];
assert('versioned Argon beats unversioned Argon', pickedArgon(unversionedAndVersioned), '4 Argon');

assert('zero Argon candidates returns null', pickedArgon([
    { text: '3.5 Flash-Lite 最快答案', dataModeId: 'cf41' },
    { text: 'Flash', dataModeId: 'gen' },
    { text: '3.8 Flash 全面協助', dataModeId: 'fbb1' },
    { text: '3.1 Pro 進階數學和程式碼', dataModeId: '9d8c' },
]), null);

console.log('\nT4: default requires newest Argon AND high reasoning');
const argonHigh = [
    { text: '3.8 Flash 全面協助', dataModeId: 'fbb1', selected: false },
    { text: 'Argon', dataModeId: 'argon1', selected: true },
    { text: '3.1 Pro 進階數學和程式碼', dataModeId: '9d8c', selected: false },
    { text: '延伸思考 解決複雜問題', dataModeId: null, selected: true },
];
assert('recognizes localized Extended Thinking as high reasoning', isHighReasoningText('延伸思考 解決複雜問題'));
assert('recognizes High reasoning row', isHighReasoningText('High'));
assert('recognizes High reasoning English label', isHighReasoningText('High reasoning'));
assert('recognizes 高階推理 as high reasoning', isHighReasoningText('高階推理'));
assert('recognizes short 高 submenu row as high reasoning', isHighReasoningText('高'));
assert('recognizes live zh-TW High row 高 詳盡徹底', isHighReasoningText('高 詳盡徹底'));
assert('rejects live zh-TW Low row 低 快捷高效', isHighReasoningText('低 快捷高效'), false);
assert('rejects live zh-TW Medium row 中等 深度適中', isHighReasoningText('中等 深度適中'), false);
assert('思考水平 is not itself high reasoning', isHighReasoningText('思考水平'), false);
assert('recognizes 深度思考 as high reasoning', isHighReasoningText('深度思考'));
assert('recognizes Think longer as high reasoning', isHighReasoningText('Think longer'));
assert('rejects standard thinking label', isHighReasoningText('標準思考'), false);
assert('rejects Fast thinking label', isHighReasoningText('Fast'), false);
assert('thinking-level parent is not high reasoning', isHighReasoningText('思考程度'), false);
assert('recognizes zh-TW thinking parent', isThinkingParentText('思考程度'));
assert('recognizes live zh-TW 思考水平 parent', isThinkingParentText('思考水平'));
assert('recognizes English thinking parent', isThinkingParentText('Thinking'));
assert('bare Thinking is not high reasoning', isHighReasoningText('Thinking'), false);
assert('Extended thinking is not a parent', isThinkingParentText('延伸思考 解決複雜問題'), false);
assert('accepts selected Argon + Extended menu state', isDefaultArgonHighMenuState(argonHigh));
assert('accepts selected Argon + High menu state', isDefaultArgonHighMenuState([
    { text: 'Argon', dataModeId: 'argon1', selected: true },
    { text: 'High', dataModeId: null, selected: true },
]));
const liveArgonThinkingLevels = [
    { text: '3.5 Flash-Lite 最快答案', dataModeId: 'lite', selected: false },
    { text: '3.8 Flash 全面協助', dataModeId: 'flash', selected: false },
    { text: '3.1 Pro 進階推論', dataModeId: 'pro', selected: false },
    { text: '4 Argon 複雜任務', dataModeId: 'argon', selected: true },
    { text: '思考水平', dataModeId: '', selected: false },
    { text: '低 快捷高效', dataModeId: '', selected: false },
    { text: '中等 深度適中', dataModeId: '', selected: false },
    { text: '高 詳盡徹底', dataModeId: '', selected: true },
];
assert('live 2026-10-14 4 Argon + 高 詳盡徹底 is default', isDefaultArgonHighMenuState(liveArgonThinkingLevels));
assert('live 4 Argon + Low thinking is not default', isDefaultArgonHighMenuState(
    liveArgonThinkingLevels.map(item => ({
        ...item,
        selected: item.text.startsWith('4 Argon') || item.text.startsWith('低'),
    }))
), false);
assert('rejects Argon without high reasoning', isDefaultArgonHighMenuState(
    argonHigh.map(item => ({ ...item, selected: item.text === 'Argon' }))
), false);
assert('rejects Flash + Extended Thinking as the Argon default', isDefaultArgonHighMenuState(
    argonHigh.map(item => ({
        ...item,
        selected: item.text.startsWith('3.8') || item.text.startsWith('延伸'),
    }))
), false);
assert('rejects Pro + Extended Thinking as the Argon default', isDefaultArgonHighMenuState(
    argonHigh.map(item => ({
        ...item,
        selected: item.text.startsWith('3.1') || item.text.startsWith('延伸'),
    }))
), false);
assert('Pro Extended aria requires Pro identity', isProExtendedAria('開模式選擇器，目前係 Pro 延伸思考'));
assert('Pro without Extended Thinking is not Pro Extended', isProExtendedAria('開模式選擇器，目前係 Pro'), false);
assert('Argon composer aria is not Pro Extended', isProExtendedAria('開模式選擇器，目前係 Argon'), false);
assert('Flash Extended aria is not Pro Extended', isProExtendedAria('開模式選擇器，目前係 Flash 延伸思考'), false);
assert('high-reasoning selection may be proven by aria-selected', isDefaultArgonHighMenuState(
    argonHigh.map(item => item.text.startsWith('延伸')
        ? { ...item, selected: false, ariaSelected: 'true' }
        : item)
));

assert(
    'stale 3 Argon selection fails when a newer Argon is in the menu',
    isDefaultArgonHighMenuState([
        { text: '3 Argon', dataModeId: 'a3', selected: true },
        { text: '4 Argon', dataModeId: 'a4', selected: false },
        { text: 'High', dataModeId: null, selected: true },
    ]),
    false
);
assert(
    '4 Argon + high is default when both 4 and 3 are present',
    isDefaultArgonHighMenuState([
        { text: '3 Argon', dataModeId: 'a3', selected: false },
        { text: '4 Argon', dataModeId: 'a4', selected: true },
        { text: 'High', dataModeId: null, selected: true },
    ])
);
assert(
    'High is preferred over Extended when both exist',
    isDefaultArgonHighMenuState([
        { text: 'Argon', dataModeId: 'argon1', selected: true },
        { text: '延伸思考 解決複雜問題', dataModeId: null, selected: true },
        { text: 'High', dataModeId: null, selected: false },
    ]),
    false
);
assert(
    'Argon + High wins when Extended is also in the menu',
    isDefaultArgonHighMenuState([
        { text: 'Argon', dataModeId: 'argon1', selected: true },
        { text: '延伸思考 解決複雜問題', dataModeId: null, selected: false },
        { text: 'High', dataModeId: null, selected: true },
    ])
);
assert(
    'zero Argon candidates cannot satisfy default even with high reasoning selected',
    isDefaultArgonHighMenuState([
        { text: '3.8 Flash 全面協助', dataModeId: 'fbb1', selected: true },
        { text: 'Flash', dataModeId: 'gen', selected: false },
        { text: '延伸思考 解決複雜問題', dataModeId: null, selected: true },
    ]),
    false
);

console.log('\nT5: zh-TW profile matches the live model-selector aria');
locales.setLocale('zh_TW');
assert('current zh-TW model selector is matched', locales.modelBtnCSS(), 'button[aria-label*="開模式選擇器"]');
assert('fuzzy selector accepts Argon composer wording', locales.FUZZY.modelAria.test('開模式選擇器，目前係 Argon'));
assert('shared locale helper recognizes Argon zh-TW aria', locales.inferLocaleFromButtonText('開模式選擇器，目前係 Argon'), 'zh_TW');
assert('shared locale helper keeps Argon out of Pro identity', isProExtendedAria('開模式選擇器，目前係 Argon'), false);
assert('legacy English model selector remains recognized', locales.inferLocaleFromButtonText('Model selector'), 'en');
assert('current English mode picker wording is recognized', locales.inferLocaleFromButtonText('Open mode picker, currently Argon'), 'en');
assert('model switch correction recognizes current English wording', inferLocaleFromAria('Open mode picker, currently Pro Extended'), 'en');
assert('English discovery selector is case-insensitive', locales.MODEL_BUTTON_DISCOVERY_SELECTOR.includes('aria-label*="mode picker" i'));
locales.setLocale(null);

console.log('\nT6: legacy selector cache cannot poison default selection');
const oldStateDir = process.env.AGENTCHAT_STATE_DIR;
const os = require('os');
const fs = require('fs');
const path = require('path');
const modelSwitchSource = fs.readFileSync(path.join(__dirname, '..', 'geminiModelSwitch.js'), 'utf8');
const adapterSource = fs.readFileSync(path.join(__dirname, '..', 'providers', 'adapters', 'gemini.js'), 'utf8');
assert('active menu path removed the self-excluding English predicate', !modelSwitchSource.includes('extRe.test(t) && !thinkRe.test(t)'));
assert('active menu path retains an explicit Extended identity guard', modelSwitchSource.includes('thinkRe.test(t) && !/extend|扩展|延伸|延長|拡張/i.test(t)'));
assert('default path calls ensureArgon', adapterSource.includes('ensureArgon(page, log)'));
assert('legacy flash is aliased before routing', adapterSource.includes('resolveGeminiModelChoice'));
assert('composer Argon aria is not a success predicate', modelSwitchSource.includes('isDefaultArgonHighMenuState'));
assert('verified path always opens the model menu', modelSwitchSource.includes('open the verified model menu and inspect checked rows'));
assert('does not toggle-close an already-open model menu', modelSwitchSource.includes('isGeminiModelMenuOpen'));
assert('polls for high-reasoning rows after model options fill', modelSwitchSource.includes('Model options often fill before the thinking-level row'));
assert('dumps open menu items when high reasoning is missing', modelSwitchSource.includes('open menu items (high reasoning not found)'));
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

console.log('\nT7: full-flash opt-in still picks newest full Flash + high reasoning');
assert('flash opt-in id describes newest-full-flash', /newest-full-flash/i.test(DEFAULT_FLASH_MODEL.id));
assert('accepts 3.6 Flash label as a full Flash candidate', isDefaultFlashText('3.6 Flash 全面協助'));
assert('accepts 3.7 Flash as a full Flash candidate', isDefaultFlashText('3.7 Flash 全面協助'));
assert('rejects 3.5 Flash-Lite', isDefaultFlashText('3.5 Flash-Lite 最快答案 新'), false);
assert('rejects generic Flash composer label', isDefaultFlashText('Flash'), false);
assert('recognizes localized Extended Thinking item', isExtendedThinkingText('延伸思考 解決複雜問題'));
const flashExtended = [
    { text: '3.5 Flash-Lite 最快答案', dataModeId: 'cf41', selected: false },
    { text: '3.6 Flash 全面協助', dataModeId: 'fbb1', selected: true },
    { text: '3.1 Pro 進階數學和程式碼', dataModeId: '9d8c', selected: false },
    { text: '延伸思考 解決複雜問題', dataModeId: null, selected: true },
];
assert('accepts selected 3.6 Flash + Extended menu state for opt-in', isDefaultFlashExtendedMenuState(flashExtended));
assert('rejects 3.6 Flash without high reasoning for opt-in', isDefaultFlashExtendedMenuState(
    flashExtended.map(item => ({ ...item, selected: item.text.startsWith('3.6') }))
), false);
assert(
    'fixture Lite + 3.6 Flash + Pro picks 3.6 for opt-in',
    pickedFlash(flashExtended),
    '3.6 Flash 全面協助'
);
assert('selected 3.6 still counts as a full Flash candidate', isDefaultFlashItem({
    text: '3.6 Flash 全面協助', selected: true,
}));
assert(
    '3.7 Flash + Extended is opt-in when both 3.7 and 3.6 are present',
    isDefaultFlashExtendedMenuState([
        { text: '3.6 Flash 全面協助', dataModeId: 'fbb1', selected: false },
        { text: '3.7 Flash 全面協助', dataModeId: 'aa77', selected: true },
        { text: '延伸思考 解決複雜問題', dataModeId: null, selected: true },
    ])
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
