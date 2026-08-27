#!/usr/bin/env node
/**
 * Unit tests for /agentweb-setup page-state classification.
 * HTML/URL fixtures only — no live Chrome.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SKILL = path.resolve(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');

const { PROVIDER_CHAIN } = require(path.join(ROOT, 'skills/lib/providers/chain'));
const {
    STATUSES,
    classifySession,
    classifyMany,
    isAuthUrl,
    REGION_BAN_URL_RE,
} = require(path.join(ROOT, 'skills/lib/providers/sessionState'));

let pass = 0, fail = 0;
function ok(cond, name, detail) {
    if (cond) { pass++; console.log('  PASS ' + name); }
    else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

const doubao = PROVIDER_CHAIN.find(p => p.key === 'doubao');
const claude = PROVIDER_CHAIN.find(p => p.key === 'claude');
const chatglm = PROVIDER_CHAIN.find(p => p.key === 'chatglm');
const gemini = PROVIDER_CHAIN.find(p => p.key === 'gemini');
const chatgpt = PROVIDER_CHAIN.find(p => p.key === 'chatgpt');

const doubaoHtml = fs.readFileSync(path.join(FIX, 'doubao-region-ban.html'), 'utf8');
const claudeHtml = fs.readFileSync(path.join(FIX, 'claude-org-disabled.html'), 'utf8');
const glmHtml = fs.readFileSync(path.join(FIX, 'chatglm-logged-out.html'), 'utf8');
const geminiHtml = fs.readFileSync(path.join(FIX, 'ready-gemini.html'), 'utf8');
const REGION_BAN_URL = 'https://www.doubao.com/security/doubao-region-ban?source=1';

console.log('── Doubao region-ban fixtures (authDomains miss) ──');
ok(!!doubao, 'doubao is on PROVIDER_CHAIN');
ok(!(doubao.authDomains || []).some(d => REGION_BAN_URL.includes(d)),
    'authDomains-only MISSES the region-ban URL');
ok(!isAuthUrl(REGION_BAN_URL, doubao),
    'isAuthUrl does not treat region-ban as generic login');
ok(REGION_BAN_URL_RE.test(REGION_BAN_URL), 'region-ban URL regex matches proof URL');

let r = classifySession({
    url: REGION_BAN_URL,
    title: 'doubao',
    html: doubaoHtml,
    buttons: ['Dola', 'login'],
    hasEditor: false,
}, doubao);
ok(r.status === STATUSES.REGION_BLOCK_UNTIL_LOGIN,
    'HTML+URL fixture -> region_block_until_login', r.status + ' ' + r.evidence);
ok(r.needsLogin === true, 'region-ban needsLogin');
ok(r.ready === false, 'region-ban is not ready');
ok(r.loginUrl === doubao.url, 'loginUrl is official PROVIDER_CHAIN url, not the ban page');

r = classifySession({
    url: REGION_BAN_URL,
    text: '',
    hasEditor: false,
}, doubao);
ok(r.status === STATUSES.REGION_BLOCK_UNTIL_LOGIN,
    'URL-only (no body) still classifies region-ban', r.status);

r = classifySession({
    url: 'https://www.doubao.com/chat/',
    text: '受区域限制，请先登录再使用豆包。你也可以选择使用 Dola。',
    hasEditor: false,
}, doubao);
ok(r.status === STATUSES.REGION_BLOCK_UNTIL_LOGIN,
    'copy-only on /chat/ (pre-redirect) -> region_block_until_login', r.status);
ok(r.status !== STATUSES.LOGGED_OUT, 'region-ban copy is NOT collapsed into logged_out');

console.log('── org_disabled / logged_out / ready ──');
r = classifySession({
    url: 'https://claude.ai/new',
    title: 'New chat - Claude',
    html: claudeHtml,
    text: 'This organization has been disabled',
    hasEditor: true,
}, claude);
ok(r.status === STATUSES.ORG_DISABLED, 'Claude Free org-disabled', r.status);
ok(r.needsLogin === false, 'org_disabled is not a login-needed state');

r = classifySession({
    url: 'https://chatglm.cn/main/alltoolsdetail?lang=zh',
    html: glmHtml,
    text: '未登录 请先登录后使用 ChatGLM',
    buttons: ['登录'],
    hasEditor: false,
}, chatglm);
ok(r.status === STATUSES.LOGGED_OUT, 'ChatGLM logged-out copy -> logged_out', r.status);

// Live miss 1: Claude composer visible, org-disabled in HTML only (not innerText).
r = classifySession({
    url: 'https://claude.ai/new',
    title: 'New chat - Claude',
    text: 'Claude New Projects Artifacts karl · Free Free plan Upgrade Evening, karl',
    html: claudeHtml,
    hasEditor: true,
}, claude);
ok(r.status === STATUSES.ORG_DISABLED, 'Claude org-disabled HTML + visible editor -> org_disabled', r.status + ' ' + r.evidence);
ok(r.ready === false, 'Claude org-disabled is not ready even with editor');

// Live miss 1b: banner absent; chat-org api_disabled_reason present.
r = classifySession({
    url: 'https://claude.ai/new',
    text: 'Evening, karl Reply with only the word PONG',
    hasEditor: true,
    orgDisabledReason: 'trust_and_safety',
}, claude);
ok(r.status === STATUSES.ORG_DISABLED, 'Claude orgDisabledReason + editor -> org_disabled', r.status);

// Live miss 2: ChatGLM composer + sidebar 登录 (not 未登录, not a <button>).
r = classifySession({
    url: 'https://chatglm.cn/main/alltoolsdetail?lang=zh',
    html: glmHtml,
    text: '新对话 学习搭子 登录 登录送积分好礼 ChatGLM 今天，有什么新想法？',
    buttons: ['更多'],
    hasEditor: true,
    sidebarUser: '登录',
    sidebarLoggedOut: true,
}, chatglm);
ok(r.status === STATUSES.LOGGED_OUT, 'ChatGLM composer + sidebar 登录 -> logged_out', r.status + ' ' + r.evidence);

r = classifySession({
    url: 'https://chatglm.cn/main/alltoolsdetail?lang=zh',
    html: '<div class="userInfoBar"><div class="sidebar-avatar guest-avatar"></div><p class="sidebar-user-name">登录</p></div><textarea></textarea>',
    text: '登录送积分好礼 ChatGLM',
    hasEditor: true,
}, chatglm);
ok(r.status === STATUSES.LOGGED_OUT, 'ChatGLM html-only sidebar-user-name 登录 + editor -> logged_out', r.status);

r = classifySession({
    url: 'https://chatglm.cn/main/alltoolsdetail?lang=zh',
    text: '未登录 ' + 'x'.repeat(1600),
    html: '<span>未登录</span><textarea></textarea>',
    hasEditor: true,
}, chatglm);
ok(r.status === STATUSES.LOGGED_OUT, 'ChatGLM 未登录 + long text + editor still logged_out', r.status);

r = classifySession({
    url: 'https://chatglm.cn/login',
    text: '',
    hasEditor: false,
}, chatglm);
ok(r.status === STATUSES.LOGGED_OUT, 'ChatGLM /login path -> logged_out', r.status);

r = classifySession({
    url: 'https://gemini.google.com/u/0/app',
    html: geminiHtml,
    text: 'Ask Gemini PONG',
    hasEditor: true,
}, gemini);
ok(r.status === STATUSES.READY, 'Gemini PONG ready', r.status);

r = classifySession({
    url: 'https://chatgpt.com/c/6a8f4b0f-56c0-83e9-88f2-08d7cd4f137f',
    title: 'Reply PONG',
    text: 'Reply PONG',
    hasEditor: true,
}, chatgpt);
ok(r.status === STATUSES.READY, 'ChatGPT PONG ready', r.status);

r = classifySession({
    url: 'https://gemini.google.com/u/0/app',
    html: '<a href="https://accounts.google.com/ServiceLogin?foo=1">Sign in</a>',
    hasEditor: true,
}, gemini);
ok(r.status === STATUSES.LOGGED_OUT, 'Gemini signed-out landing (editor present) -> logged_out', r.status);

r = classifySession({
    url: 'https://chatgpt.com/',
    text: "You have reached your limit. Upgrade to Plus.",
    hasEditor: true,
}, chatgpt);
ok(r.status === STATUSES.QUOTA, 'ChatGPT quota banner -> quota', r.status);

r = classifySession({ present: false }, gemini);
ok(r.status === STATUSES.NO_TAB, 'missing tab -> no_tab', r.status);

console.log('── 2026-08-27 browser-pass fixture map ──');
const passMap = JSON.parse(fs.readFileSync(path.join(FIX, 'browser-pass-2026-08-27.json'), 'utf8'));
const many = classifyMany(passMap);
const byKey = Object.fromEntries(many.map(x => [x.provider.key, x.status]));
ok(byKey.gemini === 'ready', 'pass map gemini ready', byKey.gemini);
ok(byKey.chatgpt === 'ready', 'pass map chatgpt ready', byKey.chatgpt);
ok(byKey.claude === 'org_disabled', 'pass map claude org_disabled', byKey.claude);
ok(byKey.chatglm === 'logged_out', 'pass map chatglm logged_out', byKey.chatglm);
ok(byKey.doubao === 'region_block_until_login', 'pass map doubao region_block_until_login', byKey.doubao);

console.log('── CLI --dry-detect (no Chrome) ──');
const cli = path.join(SKILL, 'index.js');
const child = spawnSync(process.execPath, [
    cli, '--dry-detect', '--fixtures=' + path.join(FIX, 'browser-pass-2026-08-27.json'), '--json',
], { encoding: 'utf8', cwd: ROOT, env: Object.assign({}, process.env, { AGENTCHAT_NO_AUTOSTART: '1' }) });
ok(child.status === 0, 'CLI --dry-detect exits 0', String(child.status) + ' ' + String(child.stderr || '').slice(0, 240));
ok(/Gemini\s+ready/.test(child.stdout), 'CLI table lists Gemini ready');
ok(/ChatGPT\s+ready/.test(child.stdout), 'CLI table lists ChatGPT ready');
ok(/Claude\s+org_disabled/.test(child.stdout), 'CLI table lists Claude org_disabled');
ok(/ChatGLM\s+logged_out/.test(child.stdout), 'CLI table lists ChatGLM logged_out');
ok(/Doubao\s+region_block_until_login/.test(child.stdout), 'CLI table lists Doubao region_block_until_login');
ok(/\[receipt\] AGENTCHAT_RUN /.test(child.stderr), 'CLI emits receipt AGENTCHAT_RUN on stderr');
ok(/"skill":"agentweb-setup"/.test(child.stderr), 'receipt skill is agentweb-setup');
ok(/never types passwords/.test(child.stdout), 'CLI reminds operator not to type secrets');

const usage = spawnSync(process.execPath, [cli, '--dry-detect'], {
    encoding: 'utf8', cwd: ROOT, env: Object.assign({}, process.env, { AGENTCHAT_NO_AUTOSTART: '1' }),
});
ok(usage.status === 64, 'CLI --dry-detect without fixtures exits 64', String(usage.status));

console.log('── live-miss contracts (no Chrome) ──');
const setupSrc = fs.readFileSync(cli, 'utf8');
ok(!/browser\.close\s*\(/.test(setupSrc), 'CLI source never calls browser.close()');
ok(/context\.newPage\s*\(/.test(setupSrc), 'CLI opens a new tab via context.newPage for no_tab');
ok(/detachBrowser/.test(setupSrc), 'CLI detaches via detachBrowser');
ok(!/chrome-debug/.test(setupSrc.split('openOfficialInExistingChrome')[1] || '') || /Never start/.test(setupSrc),
    'no_tab path documents not starting chrome-debug');

const { suggestLines, detachBrowser } = require(cli);
const noTabRow = {
    provider: { name: 'MiMo', url: 'https://aistudio.xiaomimimo.com/' },
    status: STATUSES.NO_TAB,
    loginUrl: 'https://aistudio.xiaomimimo.com/',
};
ok(/opening official URL in the existing Chrome/.test(suggestLines([noTabRow])),
    'suggestLines says no_tab opens a tab in existing Chrome');
ok(typeof detachBrowser === 'function', 'detachBrowser is exported');
detachBrowser(null);
ok(true, 'detachBrowser(null) is a no-op');

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
