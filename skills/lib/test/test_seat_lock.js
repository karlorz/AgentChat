/**
 * CDP seat-lock tests (zero-dep).
 *
 * Covers acquire / busy / release / token ownership / stale pid / TTL
 * expiry / CLI exit codes. All files live under a tmp AGENTCHAT_SEAT_LOCK_DIR.
 */
'use strict';

const { spawnSync } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const LIB = path.join(ROOT, 'skills', 'lib', 'seatLock.js');
const CLI = path.join(ROOT, 'scripts', 'lib', 'seat-lock.cjs');
const WRAPPER = path.join(ROOT, 'scripts', 'seat-lock');

const {
    seatLockPath,
    readSeatLock,
    acquireSeatLock,
    renewSeatLock,
    releaseSeatLock,
} = require(LIB);

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

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-seatlock-'));
}

function envFor(dir) {
    return { ...process.env, AGENTCHAT_SEAT_LOCK_DIR: dir };
}

console.log('── seatLock library ──');

test('seatLockPath uses AGENTCHAT_SEAT_LOCK_DIR or /tmp', () => {
    const dir = tmpDir();
    assert.strictEqual(seatLockPath(9227, { AGENTCHAT_SEAT_LOCK_DIR: dir }), path.join(dir, 'agentchat-seat-9227.lock'));
    assert.strictEqual(seatLockPath(9227, {}), '/tmp/agentchat-seat-9227.lock');
});

test('acquire then read = held; second acquire = busy/null', () => {
    const dir = tmpDir();
    const env = { AGENTCHAT_SEAT_LOCK_DIR: dir };
    const a = acquireSeatLock(9227, { owner: 'a', task: 't', pid: process.pid, env });
    assert(a && a.token, 'acquired');
    const st = readSeatLock(9227, { env });
    assert.strictEqual(st.state, 'held');
    assert.strictEqual(st.owner, 'a');
    assert.strictEqual(st.pid, process.pid);
    const b = acquireSeatLock(9227, { owner: 'b', pid: process.pid + 1, env });
    assert.strictEqual(b, null);
    releaseSeatLock(a);
});

test('release only succeeds for the owning token', () => {
    const dir = tmpDir();
    const env = { AGENTCHAT_SEAT_LOCK_DIR: dir };
    const a = acquireSeatLock(9227, { owner: 'a', pid: process.pid, env });
    const fake = { ...a, token: 'not-the-token' };
    assert.strictEqual(releaseSeatLock(fake), false);
    assert.strictEqual(readSeatLock(9227, { env }).state, 'held');
    assert.strictEqual(releaseSeatLock(a), true);
    assert.strictEqual(readSeatLock(9227, { env }).state, 'free');
});

test('stale dead pid is reclaimable', () => {
    const dir = tmpDir();
    const env = { AGENTCHAT_SEAT_LOCK_DIR: dir };
    const lockPath = seatLockPath(9227, env);
    const deadPid = 2147483646;
    try { process.kill(deadPid, 0); }
    catch (e) { assert.strictEqual(e.code, 'ESRCH'); }
    fs.writeFileSync(lockPath, JSON.stringify({
        owner: 'dead',
        pid: deadPid,
        host: os.hostname(),
        task: 'x',
        token: 'old',
        started_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
    }) + '\n');
    const st = readSeatLock(9227, { env });
    assert.strictEqual(st.state, 'stale');
    const a = acquireSeatLock(9227, { owner: 'live', pid: process.pid, env });
    assert(a && a.token !== 'old');
    releaseSeatLock(a);
});

test('TTL expiry is reclaimable even if pid is alive', () => {
    const dir = tmpDir();
    const env = { AGENTCHAT_SEAT_LOCK_DIR: dir };
    const lockPath = seatLockPath(9227, env);
    fs.writeFileSync(lockPath, JSON.stringify({
        owner: 'old',
        pid: process.pid,
        host: os.hostname(),
        task: 'x',
        token: 'expired',
        started_at: new Date(Date.now() - 120_000).toISOString(),
        expires_at: new Date(Date.now() - 1000).toISOString(),
    }) + '\n');
    const st = readSeatLock(9227, { env });
    assert.strictEqual(st.state, 'stale');
    const a = acquireSeatLock(9227, { owner: 'new', pid: process.pid, env });
    assert(a && a.owner === 'new');
    releaseSeatLock(a);
});

test('renew extends expires_at for the owner token', () => {
    const dir = tmpDir();
    const env = { AGENTCHAT_SEAT_LOCK_DIR: dir };
    const a = acquireSeatLock(9227, { owner: 'a', pid: process.pid, env, ttlMs: 60_000 });
    const later = Date.now() + 10_000;
    const next = renewSeatLock(a, { env, now: later, ttlMs: 120_000 });
    assert(next);
    assert.strictEqual(next.token, a.token);
    const exp = Date.parse(next.expires_at);
    assert(exp >= later + 120_000 - 5);
    const denied = renewSeatLock({ ...a, token: 'nope' }, { env });
    assert.strictEqual(denied, null);
    releaseSeatLock(a);
});

test('same owner+pid re-acquire returns the existing handle', () => {
    const dir = tmpDir();
    const env = { AGENTCHAT_SEAT_LOCK_DIR: dir };
    const a = acquireSeatLock(9227, { owner: 'a', pid: process.pid, env });
    const b = acquireSeatLock(9227, { owner: 'a', pid: process.pid, env });
    assert(b && b.token === a.token);
    releaseSeatLock(a);
});

console.log('── seat-lock CLI ──');

function runCli(args, dir, extraEnv = {}) {
    return spawnSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8',
        env: { ...process.env, AGENTCHAT_SEAT_LOCK_DIR: dir, ...extraEnv },
    });
}

test('CLI acquire --json exits 0 and prints token; second acquire exits 2', () => {
    const dir = tmpDir();
    const a = runCli(['acquire', '9227', '--owner', 'cli', '--json'], dir);
    assert.strictEqual(a.status, 0, a.stderr);
    const body = JSON.parse(a.stdout);
    assert.strictEqual(body.ok, true);
    assert(body.token);
    const b = runCli(['acquire', '9227', '--owner', 'other', '--json'], dir);
    assert.strictEqual(b.status, 2);
    const rel = runCli(['release', '9227', '--owner', 'cli', '--token', body.token, '--json'], dir);
    assert.strictEqual(rel.status, 0, rel.stderr);
});

test('CLI default acquire is TTL-only (no pid)', () => {
    const dir = tmpDir();
    const a = runCli(['acquire', '9227', '--owner', 'shell', '--json'], dir);
    assert.strictEqual(a.status, 0, a.stderr);
    const st = runCli(['status', '9227', '--json'], dir);
    const body = JSON.parse(st.stdout);
    assert.strictEqual(body.state, 'held');
    assert.strictEqual(body.pid, null);
    const tok = JSON.parse(a.stdout).token;
    runCli(['release', '9227', '--owner', 'shell', '--token', tok], dir);
});

test('CLI release with wrong token exits 2; usage errors exit 64', () => {
    const dir = tmpDir();
    const a = runCli(['acquire', '9227', '--owner', 'cli', '--json'], dir);
    const tok = JSON.parse(a.stdout).token;
    const bad = runCli(['release', '9227', '--owner', 'cli', '--token', 'nope'], dir);
    assert.strictEqual(bad.status, 2);
    const usage = runCli(['acquire'], dir);
    assert.strictEqual(usage.status, 64);
    const noOwner = runCli(['acquire', '9227'], dir);
    assert.strictEqual(noOwner.status, 64);
    runCli(['release', '9227', '--owner', 'cli', '--token', tok], dir);
});

test('CLI renew + wrapper script', () => {
    const dir = tmpDir();
    const a = runCli(['acquire', '9227', '--owner', 'cli', '--json', '--ttl-min', '1'], dir);
    const tok = JSON.parse(a.stdout).token;
    const r = runCli(['renew', '9227', '--owner', 'cli', '--token', tok, '--json'], dir);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout).ok, true);
    if (fs.existsSync(WRAPPER)) {
        const w = spawnSync(WRAPPER, ['status', '9227', '--json'], {
            encoding: 'utf8',
            env: { ...process.env, AGENTCHAT_SEAT_LOCK_DIR: dir },
        });
        assert.strictEqual(w.status, 0, w.stderr);
        assert.strictEqual(JSON.parse(w.stdout).state, 'held');
    }
    runCli(['release', '9227', '--owner', 'cli', '--token', tok], dir);
});

test('CLI --pid records pid', () => {
    const dir = tmpDir();
    const a = runCli(['acquire', '9227', '--owner', 'bot', '--pid', String(process.pid), '--json'], dir);
    assert.strictEqual(a.status, 0, a.stderr);
    const st = JSON.parse(runCli(['status', '9227', '--json'], dir).stdout);
    assert.strictEqual(st.pid, process.pid);
    const tok = JSON.parse(a.stdout).token;
    runCli(['release', '9227', '--owner', 'bot', '--token', tok], dir);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
