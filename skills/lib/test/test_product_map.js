#!/usr/bin/env node
/**
 * Product-map + live-safety: demo hub / MCP / receipts must match chain.js.
 * No Chrome. Source + parser only.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { PROVIDER_CHAIN } = require(path.join(ROOT, 'skills/lib/providers/chain'));

let pass = 0, fail = 0;
function ok(cond, name, detail) {
    if (cond) { pass++; console.log('  PASS ' + name); }
    else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

const keys = PROVIDER_CHAIN.map(p => p.key);
const receipt = require(path.join(ROOT, 'skills/lib/receipt'));

console.log('── parseReceiptLine ──');
ok(typeof receipt.parseReceiptLine === 'function', 'receipt exports parseReceiptLine');
const sample = 'log\n[receipt] AGENTCHAT_RUN {"run_id":"ac-1","skill":"AgentChat-OneWeb","exit":0,"provider_used":"Gemini","total_ms":12}\n';
const parsed = receipt.parseReceiptLine ? receipt.parseReceiptLine(sample) : null;
ok(parsed && parsed.run_id === 'ac-1' && parsed.provider_used === 'Gemini',
    'parseReceiptLine reads AGENTCHAT_RUN JSON', parsed && JSON.stringify(parsed));
ok(receipt.parseReceiptLine && receipt.parseReceiptLine('no receipt here') === null,
    'parseReceiptLine returns null when missing');

console.log('── productMap module ──');
let productMap;
try { productMap = require(path.join(ROOT, 'skills/lib/providers/productMap')).productMap; } catch (e) {
    productMap = null;
    ok(false, 'productMap module loads', e.message);
}
if (productMap) {
    const map = productMap();
    ok(map.providerCount === keys.length, 'productMap.providerCount matches chain', String(map.providerCount));
    ok(Array.isArray(map.providers) && map.providers.every(p => keys.includes(p.key)),
        'productMap.providers keys are chain keys');
    ok(map.providers.some(p => p.key === 'chatglm') && map.providers.some(p => p.key === 'doubao'),
        'productMap includes chatglm and doubao');
    const skillNames = (map.skills || []).map(s => s.name).join(' ');
    ok(/AgentChat-OneWeb/.test(skillNames), 'skills list names OneWeb');
    ok(/IndependentTasks/.test(skillNames), 'skills list names IndependentTasks');
    ok(/WebSubAgent/.test(skillNames), 'skills list names WebSubAgent');
    ok(/agentweb-setup/.test(skillNames), 'skills list names agentweb-setup');
    ok(!/WebExtended/.test(skillNames) && !/FreeSubAgent/.test(skillNames),
        'skills list does not use retired names');
}

console.log('── demo HTML matches HEAD ──');
const indexHtml = fs.readFileSync(path.join(ROOT, 'demo/index.html'), 'utf8');
ok(indexHtml.includes('AgentChat-OneWeb'), 'hub names AgentChat-OneWeb');
ok(indexHtml.includes('AgentChat-IndependentTasks'), 'hub names IndependentTasks');
ok(indexHtml.includes('AgentChat-WebSubAgent'), 'hub names WebSubAgent');
ok(indexHtml.includes('agentweb-setup'), 'hub has agentweb-setup card');
ok(!indexHtml.includes('AgentChat-WebExtended'), 'hub does not say WebExtended');
ok(!indexHtml.includes('AgentChat-FreeSubAgent'), 'hub does not say FreeSubAgent');
ok(!/>8<\/div><div class="lbl">AI Providers/.test(indexHtml), 'hub does not claim 8 providers');
ok(indexHtml.includes(String(keys.length)) && /AI Providers/.test(indexHtml),
    'hub shows chain provider count', String(keys.length));
ok(!/Gemini Pro Extended →/.test(indexHtml), 'hub does not claim Pro Extended as default chain');
ok(fs.existsSync(path.join(ROOT, 'demo/setup.html')), 'demo/setup.html exists');

const webext = fs.readFileSync(path.join(ROOT, 'demo/webextended.html'), 'utf8');
ok(webext.includes('AgentChat-OneWeb'), 'fallback page names OneWeb');
ok(!/Gemini Pro Extended 已就绪/.test(webext), 'fallback page does not claim Pro Extended ready');
ok(!/Gemini Pro Extended 首选/.test(webext), 'fallback page does not pin Pro Extended as first choice');
for (const k of keys) {
    ok(webext.includes("k:'" + k + "'") || webext.includes('k:"' + k + '"') || webext.includes("'" + k + "'"),
        'fallback page mentions provider ' + k);
}

const scripts = webext.match(/<script>([\s\S]*?)<\/script>/g) || [];
let parsedOk = false;
let parseErr = '';
for (const block of scripts) {
    const body = block.replace(/^<script>/, '').replace(/<\/script>$/, '');
    if (!body.includes('function send')) continue;
    try { new vm.Script(body); parsedOk = true; } catch (e) { parseErr = e.message; }
}
ok(parsedOk, 'webextended.html send() script parses', parseErr);
ok(!/fetch\(['"]\/api\/smoke['"]\)/.test(webext),
    'fallback page does not auto-hit /api/smoke (would spawn provider tabs)');

const arch = fs.readFileSync(path.join(ROOT, 'demo/architecture.html'), 'utf8');
ok(arch.includes('AgentChat-OneWeb'), 'architecture names OneWeb');
ok(!arch.includes('skills/AgentChat-WebExtended/'), 'architecture data-flow uses real skill path');
ok(!/>Pending</.test(arch), 'architecture timeline is not stuck on Pending');
ok(arch.includes('chatglm') || arch.includes('ChatGLM'), 'architecture mentions ChatGLM');
ok(arch.includes('doubao') || arch.includes('Doubao'), 'architecture mentions Doubao');

const parallel = fs.readFileSync(path.join(ROOT, 'demo/freesubagent.html'), 'utf8');
ok(parallel.includes('IndependentTasks'), 'parallel page names IndependentTasks');
ok(!parallel.includes('AgentChat-WebExtended'), 'parallel page does not spawn WebExtended path');
ok(!parallel.includes('8 Providers'), 'parallel page does not claim 8 providers');

const mcpHtml = fs.readFileSync(path.join(ROOT, 'demo/mcp.html'), 'utf8');
ok(!/调用 8 个 AI Provider/.test(mcpHtml), 'mcp.html does not say 8 providers');
ok(!/z\.enum\(8值\)/.test(mcpHtml), 'mcp.html enum is not hardcoded to 8');

console.log('── demo_server live-safety ──');
const demoSrc = fs.readFileSync(path.join(ROOT, 'scripts/demo_server.js'), 'utf8');
ok(!/function closeOldProviderTabs/.test(demoSrc), 'demo_server does not define closeOldProviderTabs');
ok(!/json\/close\//.test(demoSrc), 'demo_server does not CDP-close tabs');
ok(!/AGENTCHAT_SKIP_MODEL_SWITCH/.test(demoSrc), 'demo_server does not set SKIP_MODEL_SWITCH');
ok(/createExecutor/.test(demoSrc), 'demo_server uses execute.js');
ok(!/parseReceiptLine/.test(demoSrc),
    'demo_server does not scrape receipts (runChain already returns provider_used)');
ok(/productMap/.test(demoSrc), 'demo_server reads productMap');
ok(!/providers:\s*8/.test(demoSrc), 'demo_server /api/stats is not hardcoded to 8 providers');
ok(/no-store/.test(demoSrc), 'demo_server sends no-store so webextended.html refresh is fresh');

console.log('── MCP chain SSOT ──');
const mcpSrc = fs.readFileSync(path.join(ROOT, 'skills/mcp-server/index.mjs'), 'utf8');
ok(/providers\/chain/.test(mcpSrc), 'mcp-server imports chain.js');
ok(!/PROVIDER_NAMES = \[\s*"gemini", "chatgpt", "claude", "qwen"/.test(mcpSrc),
    'mcp-server does not hardcode the old 8-name list');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
