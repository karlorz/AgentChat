/**
 * Live Box Chrome Seat Census & Fail-Closed Guard Tests.
 *
 * Validates:
 *   1. DISPLAY :N -> /home/box/chrome-profile/Fork-N -> CDP 9222+N.
 *   2. AgentChat reserves default CDP 9222 and never defaults to Fork-5 / 9227.
 *   3. Fail-closed guards: unsafe actions (kill-chrome, rewrite-env, start-8737, start-coolify)
 *      are strictly blocked unless AGENTCHAT_KARL_AUTHORIZED=1.
 *   4. Safe configuration passes check-action without false positives.
 *   5. CLI exit codes: 0 for census report, 1 for blocked check-action.
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CENSUS_MODULE = path.join(ROOT, 'scripts', 'lib', 'seat-census.cjs');
const CENSUS_CLI = path.join(ROOT, 'scripts', 'check-seats');

const {
    AGENTCHAT_DEFAULT_CDP_PORT,
    UNSAFE_ACTIONS,
    forkSeat,
    KNOWN_BOX_SEATS,
    inspectSeatConfig,
    guardUnsafeAction,
} = require(CENSUS_MODULE);

let pass = 0, fail = 0;
const test = (name, fn) => {
    try {
        fn();
        pass++;
        console.log('  PASS', name);
    } catch (err) {
        fail++;
        console.log('  FAIL', name, err.message);
    }
};

console.log('── Live Box Seat Census & Invariants ──');

test('census includes all four documented coordinator seats', () => {
    const ports = KNOWN_BOX_SEATS.map(s => s.port);
    assert(ports.includes(9227), 'must include 9227 (Fork-5)');
    assert(ports.includes(9226), 'must include 9226 (Fork-4)');
    assert(ports.includes(9232), 'must include 9232 (Fork-10)');
    assert(ports.includes(9222), 'must include 9222 (AgentChat reserved default)');
});

test('Fork-N seats derive display, profile, and port from N', () => {
    for (const n of [4, 5, 10]) {
        const seat = KNOWN_BOX_SEATS.find(s => s.seat === `Fork-${n}`);
        assert(seat, `Fork-${n} exists`);
        assert.deepStrictEqual(seat, forkSeat(n, n === 5
            ? { notes: 'Contested seat. Fail-closed against killing or hijacking.' }
            : {}));
    }
});

test('9222 is reserved for AgentChat and has no Fork-N display or profile', () => {
    const agentChatSeat = KNOWN_BOX_SEATS.find(s => s.port === AGENTCHAT_DEFAULT_CDP_PORT);
    assert(agentChatSeat, '9222 exists');
    assert.strictEqual(agentChatSeat.seat, 'AgentChat');
    assert.strictEqual(agentChatSeat.status, 'reserved');
    assert.strictEqual(agentChatSeat.assignedOwner, 'AgentChat');
    assert.strictEqual(agentChatSeat.display, null);
    assert.strictEqual(agentChatSeat.profile, null);
});

test('empty configuration defaults AgentChat to CDP 9222, never Fork-5', () => {
    const res = inspectSeatConfig({});
    assert.strictEqual(res.configuredPort, 9222);
    assert.strictEqual(res.matchedSeat.seat, 'AgentChat');
    assert.strictEqual(res.isSeatCollision, false);
    assert.strictEqual(res.isFork5Collision, false);
});

console.log('── Configuration Inspection & Collision Detection ──');

test('detects Fork-5 collision when CDP_PORT=9227', () => {
    const res = inspectSeatConfig({ CDP_PORT: '9227' });
    assert.strictEqual(res.isFork5Collision, true);
    assert.strictEqual(res.isContested, true);
    assert(res.failClosedReason && res.failClosedReason.includes('Fork-5'));
});

test('detects Fork-5 collision from the canonical Fork-N profile path', () => {
    const res = inspectSeatConfig({ CDP_PORT: '9999', CHROME_PROFILE: '/home/box/chrome-profile/Fork-5' });
    assert.strictEqual(res.isFork5Collision, true);
    assert.strictEqual(res.isSeatCollision, true);
    assert.strictEqual(res.matchedProfileSeat.seat, 'Fork-5');
});

test('detects non-Fork-5 seat collisions by canonical profile or port', () => {
    const byProfile = inspectSeatConfig({ CDP_PORT: '9222', CHROME_PROFILE: '/home/box/chrome-profile/Fork-10' });
    assert.strictEqual(byProfile.isSeatCollision, true);
    assert.strictEqual(byProfile.matchedProfileSeat.seat, 'Fork-10');
    const byPort = inspectSeatConfig({ CDP_PORT: '9226' });
    assert.strictEqual(byPort.isSeatCollision, true);
    assert.strictEqual(byPort.matchedSeat.seat, 'Fork-4');
});

test('uncontested port (e.g. 9222) does not trigger collision', () => {
    const res = inspectSeatConfig({ CDP_PORT: '9222', CHROME_PROFILE: '/tmp/my-profile' });
    assert.strictEqual(res.isFork5Collision, false);
    assert.strictEqual(res.isContested, false);
});

console.log('── Fail-Closed Action Guards ──');

test('refuses kill-chrome by default without Karl authorization', () => {
    assert.throws(
        () => guardUnsafeAction('kill-chrome', { env: { CDP_PORT: '9227' } }),
        err => err.code === 'ERR_SEAT_FAIL_CLOSED' && err.message.includes('[FAIL-CLOSED BLOCKED]')
    );
});

test('refuses all destructive/live actions by default', () => {
    for (const act of UNSAFE_ACTIONS) {
        assert.throws(
            () => guardUnsafeAction(act),
            err => err.code === 'ERR_SEAT_FAIL_CLOSED'
        );
    }
});

test('allows action when AGENTCHAT_KARL_AUTHORIZED=1 is set', () => {
    const res = guardUnsafeAction('kill-chrome', {
        env: { AGENTCHAT_KARL_AUTHORIZED: '1' },
    });
    assert.strictEqual(res.allowed, true);
    assert.strictEqual(res.karlAuthorized, true);
});

console.log('── CLI Integration & Output ──');

test('CLI check-action exits 1 on refused action', () => {
    const run = spawnSync('node', [CENSUS_MODULE, '--check-action=start-8737'], { encoding: 'utf8' });
    assert.strictEqual(run.status, 1);
    assert(run.stderr.includes('[FAIL-CLOSED BLOCKED]'));
});

test('CLI check-action exits 0 when authorized by Karl', () => {
    const run = spawnSync('node', [CENSUS_MODULE, '--check-action=start-8737'], {
        encoding: 'utf8',
        env: { ...process.env, AGENTCHAT_KARL_AUTHORIZED: '1' },
    });
    assert.strictEqual(run.status, 0);
    assert(run.stdout.includes('[ALLOWED]'));
});

test('scripts/check-seats executable produces valid JSON output with --no-probe --json', () => {
    const run = spawnSync(CENSUS_CLI, ['--no-probe', '--json'], { encoding: 'utf8' });
    assert.strictEqual(run.status, 0);
    const data = JSON.parse(run.stdout);
    assert(Array.isArray(data.census), 'has census array');
    assert.strictEqual(data.census.length, 4);
    assert.strictEqual(data.rules.failClosedDefault, true);
    assert.deepStrictEqual(data.rules.prohibitedActions, UNSAFE_ACTIONS);
});

test('agentweb setup docs and CLI use AgentChat 9222, not Fork-5 as the default', () => {
    const fs = require('fs');
    const files = [
        path.join(ROOT, 'skills', 'AgentChat-agentweb-setup', 'index.js'),
        path.join(ROOT, 'skills', 'AgentChat-agentweb-setup', 'SKILL.md'),
        path.join(ROOT, 'skills', 'AgentChat-agentweb-setup', 'CHANGELOG.md'),
    ];
    const combined = files.map(file => fs.readFileSync(file, 'utf8')).join('\n');
    assert(combined.includes('9222'), 'AgentChat default 9222 is documented');
    assert(!/profile5/i.test(combined), 'profile5 is not described as AgentChat shared/default profile');
    assert(!/127\.0\.0\.1:9227/.test(combined), '9227 is not described as AgentChat endpoint');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
