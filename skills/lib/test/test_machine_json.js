#!/usr/bin/env node
/**
 * AQ-008 / D11 — machine JSON for CLI + Python SDK.
 * Zero Chrome. Schema must match Muse doctor PUBLIC_KEYS (PR #12).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const mj = require(path.join(ROOT, 'skills/lib/machineJson'));
const doctor = require(path.join(ROOT, 'skills/AgentChat-Muse/doctor.js'));

let pass = 0, fail = 0;
function ok(cond, name, detail) {
    if (cond) { pass++; console.log('  PASS', name); }
    else {
        fail++;
        console.log('  FAIL', name, detail != null ? '— ' + detail : '');
    }
}

console.log('── PR #12 schema lock ──');
ok(Array.isArray(mj.PUBLIC_KEYS) && mj.PUBLIC_KEYS.length === 6, 'PUBLIC_KEYS length 6');
ok(
    JSON.stringify([...mj.PUBLIC_KEYS].sort()) === JSON.stringify([...doctor.PUBLIC_KEYS].sort()),
    'machineJson.PUBLIC_KEYS === doctor.PUBLIC_KEYS',
    JSON.stringify(mj.PUBLIC_KEYS) + ' vs ' + JSON.stringify(doctor.PUBLIC_KEYS)
);
ok(
    JSON.stringify(mj.STATES) === JSON.stringify(['ready', 'needs_human', 'blocked']),
    'state enum is ready | needs_human | blocked'
);

const ready = mj.publicResult({
    state: 'ready', reason: 'should_be_cleared', seat: 'Fork-5', port: 9227,
    display: ':5', checked_at: '2026-10-11T06:00:00.000Z',
});
ok(ready.reason === null, 'ready forces reason null');
ok(Object.keys(ready).sort().join(',') === [...mj.PUBLIC_KEYS].sort().join(','),
    'publicResult emits exactly the 6 keys');

const human = mj.publicResult({
    state: 'needs_human', reason: 'muse_login', seat: 'Fork-5', port: 9227,
    display: ':5', checked_at: '2026-10-11T06:00:00.000Z',
});
ok(human.state === 'needs_human' && human.reason === 'muse_login',
    'needs_human + muse_login are separate fields');
ok(!Object.values(human).some(v => typeof v === 'string' && v.includes('needs_human:')),
    'never emit concatenated needs_human:muse_login');

console.log('── classifyOneWebOutcome ──');
ok(mj.classifyOneWebOutcome({ exit: 0 }).state === 'ready'
    && mj.classifyOneWebOutcome({ exit: 0 }).reason === null,
    'exit 0 → ready/null');
ok(mj.classifyOneWebOutcome({ exit: 1 }).state === 'blocked'
    && mj.classifyOneWebOutcome({ exit: 1 }).reason === 'seat',
    'exit 1 → blocked/seat');
ok(mj.classifyOneWebOutcome({ busy: true, exit: 3 }).reason === 'busy'
    && mj.classifyOneWebOutcome({ busy: true, exit: 3 }).state === 'blocked',
    'seat lock busy → blocked/busy');
ok(mj.classifyOneWebOutcome({ exit: 2, museOnly: true }).reason === 'muse_login'
    && mj.classifyOneWebOutcome({ exit: 2, museOnly: true }).state === 'needs_human',
    'muse-only auth → needs_human/muse_login');
ok(mj.classifyOneWebOutcome({ exit: 2, providerUsed: 'Gemini' }).reason === 'login'
    && mj.classifyOneWebOutcome({ exit: 2, providerUsed: 'Gemini' }).state === 'needs_human',
    'generic auth → needs_human/login');
ok(mj.classifyOneWebOutcome({ exit: 4 }).reason === 'cdp_error', 'exit 4 → cdp_error');
ok(mj.classifyOneWebOutcome({
    exit: 9,
    reasons: { gemini: { reason: 'error', stage: 'editor_find' } },
}).reason === 'no_input', 'editor_find → no_input');

console.log('── tagged parse ──');
const blob = [
    '[fallback] ✓ ChatGPT: USED (12 chars, 99ms total)',
    'Fallback chain: gemini → chatgpt (1 provider(s) skipped)',
    'Pro Extended Thinking active',
    mj.STATE_PREFIX + JSON.stringify({
        state: 'ready', reason: null, seat: 'AgentChat', port: 9222,
        display: null, checked_at: '2026-10-11T00:00:00.000Z',
        provider_used: 'Gemini', fallback_chain: ['gemini'],
        model_used: 'Flash', total_ms: 1500, exit: 0, run_id: 'ac-deadbeef',
    }),
    '[receipt] AGENTCHAT_RUN {"run_id":"ac-deadbeef","skill":"AgentChat-OneWeb","exit":0,"provider_used":"Gemini"}',
].join('\n');
const parsed = mj.parseStateLine(blob);
ok(parsed && parsed.provider_used === 'Gemini' && parsed.model_used === 'Flash',
    'STATE JSON wins over human ✓ ChatGPT / Pro Extended lines');
ok(parsed.state === 'ready' && parsed.reason === null, 'parsed state/reason match PR #12');
ok(mj.parseReceiptOrState('no json here') === null, 'missing tagged JSON → null');

const lastWins = [
    mj.STATE_PREFIX + '{"state":"blocked","reason":"seat"}',
    mj.STATE_PREFIX + '{"state":"ready","reason":null}',
].join('\n');
ok(mj.parseStateLine(lastWins).state === 'ready', 'last STATE line wins');

console.log('── build + emit ──');
const payload = mj.buildSdkPayload({
    state: 'ready', reason: 'x', seat: 'AgentChat', port: 9222,
    display: null, checked_at: '2026-10-11T00:00:00.000Z',
    provider_used: 'Gemini', fallback_chain: ['gemini', 'chatgpt'],
    model_used: 'Flash', total_ms: 42, exit: 0, run_id: 'ac-1',
});
ok(payload.reason === null, 'buildSdkPayload ready reason null');
ok(mj.PUBLIC_KEYS.every(k => Object.prototype.hasOwnProperty.call(payload, k)),
    'SDK payload includes all 6 probe keys');
ok(payload.fallback_chain.join(',') === 'gemini,chatgpt', 'fallback_chain preserved');

const chunks = [];
mj.emitStateLine(payload, (s) => chunks.push(s));
ok(chunks.length === 1 && chunks[0].startsWith(mj.STATE_PREFIX), 'emitStateLine writes tagged line');
ok(mj.parseStateLine(chunks[0]).run_id === 'ac-1', 'emitted line round-trips');

ok(mj.expectedSeat(9222).seat === 'AgentChat' && mj.expectedSeat(9222).display === null,
    '9222 → AgentChat / null display');
ok(mj.expectedSeat(9227).seat === 'Fork-5', '9227 → Fork-5');

console.log('── source contracts ──');
const sessionSrc = fs.readFileSync(path.join(ROOT, 'agentchat/session.py'), 'utf8');
ok(!/✓\\s\*\\(\\w\+\\):\\s\*USED/.test(sessionSrc)
    && !/Fallback chain:/.test(sessionSrc)
    && !/"Pro Extended" in stderr/.test(sessionSrc),
    'session.py no longer regex-scrapes human stderr');
ok(sessionSrc.includes('AGENTCHAT_STATE') && sessionSrc.includes('AGENTCHAT_RUN'),
    'session.py parses STATE then receipt');
const oneWebSrc = fs.readFileSync(path.join(ROOT, 'skills', 'AgentChat-OneWeb', 'index.js'), 'utf8');
ok(oneWebSrc.includes('emitStateLine') && oneWebSrc.includes('classifyOneWebOutcome'),
    'OneWeb CLI emits machine JSON via machineJson');

console.log('── Python SDK parse ──');
const pyRun = spawnSync('python3', [path.join(ROOT, 'test/test_session_parse.py')], {
    encoding: 'utf8',
    cwd: ROOT,
    env: { ...process.env, PYTHONPATH: ROOT },
});
if (pyRun.status === 0) {
    pass++;
    console.log('  PASS python test_session_parse.py');
    if (pyRun.stdout) process.stdout.write(pyRun.stdout.replace(/^/gm, '    '));
} else {
    fail++;
    console.log('  FAIL python test_session_parse.py status=' + pyRun.status);
    if (pyRun.stdout) process.stdout.write(pyRun.stdout);
    if (pyRun.stderr) process.stderr.write(pyRun.stderr);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
