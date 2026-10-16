#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
    classifyGeminiMcpName,
    splitGeminiMcpNames,
    readComposerMcpLayers,
    logMcpLayers,
    isGeminiMcpMentionDisabled,
    findWebcodexMentionMenuItem,
    isGeminiAppUrl,
    composerHasWebcodexMentionInDoc,
} = require('../geminiMcpLayers');

const adapterSource = fs.readFileSync(
    path.join(__dirname, '..', 'providers', 'adapters', 'gemini.js'),
    'utf8'
);

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

function ids(rows) {
    return rows.map(row => row.id);
}

console.log('T1: classify connector vs inner project');
assert('WebCodex Local Projects is connector',
    classifyGeminiMcpName('WebCodex Local Projects').layer, 'connector');
assert('Webcodex is connector', classifyGeminiMcpName('Webcodex').id, 'webcodex-local-projects');
assert('SkillWiki is connector', classifyGeminiMcpName('SkillWiki').layer, 'connector');
assert('GrokSearch is inner project', classifyGeminiMcpName('GrokSearch').layer, 'inner_project');
assert('grok-search is inner project', classifyGeminiMcpName('grok-search').id, 'groksearch');
assert('trends is inner project', classifyGeminiMcpName('trends').layer, 'inner_project');
assert('Chat/Task chips are unknown', classifyGeminiMcpName('任務').layer, 'unknown');

console.log('\nT2: split mixed ChatGPT-style table names');
const split = splitGeminiMcpNames([
    'WebCodex Local Projects',
    'SkillWiki',
    'GrokSearch',
    'trends',
]);
assert('connectors are WebCodex + SkillWiki',
    ids(split.connectors).join(','), 'webcodex-local-projects,skillwiki');
assert('inner projects are GrokSearch + trends',
    ids(split.innerProjects).join(','), 'groksearch,trends');
assert('GrokSearch is never a connector',
    split.connectors.some(row => row.id === 'groksearch'), false);

console.log('\nT3: page scan classifies chips, not leftover inner names');
(async () => {
    const page = {
        evaluate: async () => ([
            '任務',
            'Webcodex Local Projects',
            'GrokSearch',
            'trends',
        ]),
    };
    const layers = await readComposerMcpLayers(page);
    assert('scan keeps WebCodex as connector',
        ids(layers.connectors).join(','), 'webcodex-local-projects');
    assert('scan keeps GrokSearch/trends as inner',
        ids(layers.innerProjects).join(','), 'groksearch,trends');

    const logs = [];
    logMcpLayers(m => logs.push(m), layers);
    assert('log names top-level @ separately',
        logs.some(line => /mcp connectors \(top-level @\): Webcodex Local Projects/.test(line)));
    assert('log says inner projects are not @ chips',
        logs.some(line => /not @ chips\): GrokSearch, trends/.test(line)));

    assert('adapter records layers after Task verify',
        adapterSource.includes("require('../../geminiMcpLayers')")
        && adapterSource.includes('readComposerMcpLayers(page)')
        && adapterSource.includes('cfg.mcp_connectors'));

    console.log('\nT4: @Webcodex Local Projects mention picker');
    const chatMenu = findWebcodexMentionMenuItem([
        { aria: '虛擬替身', text: '虛擬替身\n在圖片和影片加入擬真肖像' },
        { aria: '技能', text: '技能\n建立可重用的指令' },
        { aria: 'Gmail', text: 'Gmail' },
        { aria: 'SkillWiki', text: 'SkillWiki' },
        { aria: 'GrokSearch', text: 'GrokSearch' },
        { aria: 'trends', text: 'trends' },
        { aria: 'Webcodex Local Projects', text: 'Webcodex Local Projects' },
    ]);
    assert('picks Webcodex Local Projects, not first built-in',
        chatMenu && chatMenu.aria, 'Webcodex Local Projects');
    assert('rejects SkillWiki / GrokSearch / trends as mention target',
        findWebcodexMentionMenuItem([
            { aria: 'SkillWiki', text: 'SkillWiki' },
            { aria: 'GrokSearch', text: 'GrokSearch' },
            { aria: 'trends', text: 'trends' },
        ]), null);
    assert('Chat-mode built-ins alone are not a WebCodex pick',
        findWebcodexMentionMenuItem([
            { aria: '虛擬替身', text: '虛擬替身' },
            { aria: '技能', text: '技能' },
        ]), null);

    console.log('\nT5: mention opt-out + chip verify helpers');
    assert('mention disabled only for literal 1', isGeminiMcpMentionDisabled('1'), true);
    assert('mention stays on when unset', isGeminiMcpMentionDisabled(''), false);
    assert('app URL stays on /app', isGeminiAppUrl('https://gemini.google.com/u/0/app/abc'), true);
    assert('avatar / customize are not app',
        isGeminiAppUrl('https://gemini.google.com/u/0/avatar')
        || isGeminiAppUrl('https://gemini.google.com/u/0/customize/skills'), false);
    const fakeDoc = {
        querySelector: (sel) => sel.includes('ql-editor')
            ? { innerText: '@Webcodex Local Projects hello', innerHTML: '<span class="mention">Webcodex Local Projects</span>' }
            : null,
    };
    assert('editor chip text counts as mention',
        composerHasWebcodexMentionInDoc(fakeDoc), true);

    assert('adapter inserts mention after fill and before keyboard prompt',
        adapterSource.includes('ensureGeminiWebcodexMention(page, glog)')
        && adapterSource.includes("mention !== 'already-on'")
        && /fill\(''\);[\s\S]*ensureGeminiWebcodexMention/.test(adapterSource)
        && adapterSource.includes('placeCaretAfterGeminiMention(page)'));
    assert('adapter fail-closes when Task mention is missing',
        adapterSource.includes('ERR_MODEL_DEGRADED')
        && adapterSource.includes('@Webcodex Local Projects mention could not be verified'));
    assert('clipboard fallback does not fill after mention',
        adapterSource.includes('if (!landed && !mentionNeeded)'));

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
