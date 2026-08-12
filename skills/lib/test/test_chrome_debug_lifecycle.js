/**
 * Chrome CDP lifecycle — behavior tests against a fake Chrome fixture.
 *
 * Every test runs in disposable directories (temp profile, temp state dir,
 * fake Chrome binary) and never touches the real Chrome or its profiles.
 * The engine is spawned via the bridge (`bash scripts/run-helper.cmd
 * chrome-debug …`) so dispatch and lifecycle are exercised end to end.
 *
 * Covered:
 *   1. One-shot launch: detached Chrome, port ready, exit 0, no state file.
 *   2. Daemon clean child exit: exactly one launch, no restart, state cleared.
 *   3. Daemon abnormal exit: bounded restart, then clean exit ends supervision.
 *   4. --stop: validated ownership stop, Chrome terminated, state cleared.
 *   5. Stale/foreign state: --stop is a safe no-op, nothing killed.
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const BRIDGE = path.join(SCRIPTS, 'run-helper.cmd');
const ENGINE = path.join(SCRIPTS, 'lib', 'chrome-debug-lifecycle.cjs');
const FAKE = path.join(__dirname, 'fixtures', 'fake_chrome.js');
// The engine spawns Chrome directly (no shell), so the fixture must be executable.
fs.chmodSync(FAKE, 0o755);

let pass = 0, fail = 0;
const assert = (name, cond, detail = '') => {
    if (cond) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name, detail); }
};

function tempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Every case gets its own port so cases never fight over a shared CDP port.
let nextPort = 9333 + Math.floor(Math.random() * 500);
function mkEnv() {
    const root = tempDir('agentchat-lifecycle-');
    const profileDir = path.join(root, 'profile');
    const stateDir = path.join(root, 'state');
    const port = String(nextPort++);
    fs.mkdirSync(profileDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    return {
        root,
        profileDir,
        stateDir,
        port,
        env: {
            ...process.env,
            CHROME_DEBUG_ENV_SKIP: '1',
            CHROME: FAKE,
            CHROMIUM_PATH: '',
            CHROME_PROFILE: profileDir,
            CHROME_DEBUG_PROFILE: '',
            CHROME_DEBUG_PROFILE_MODE: 'dedicated',   // temp dirs are not real Chrome profiles
            CDP_PORT: port,
            CHROME_DEBUG_PORT: '',
            CHROME_DEBUG_STATE_DIR: stateDir,
            CHROME_DEBUG_BACKOFF_BASE_MS: '300',
            CHROME_DEBUG_MAX_RESTARTS: '3',
            HEADLESS: '',
            FAKE_CHROME_LOG: path.join(root, 'chrome-launches.log'),
            FAKE_CHROME_CONTROL: path.join(root, 'control.json'),
        },
    };
}

function cdPUp(env) {
    return new Promise((resolve) => {
        const http = require('http');
        const req = http.get({ host: '127.0.0.1', port: Number(env.port), path: '/json/version', timeout: 1500 }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode === 200));
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

function killFakeChromes() {
    try {
        const { execFileSync } = require('child_process');
        const out = execFileSync('pgrep', ['-f', 'fixtures/fake_chrome'], { encoding: 'utf8' });
        for (const pid of out.trim().split(/\r?\n/).filter(Boolean)) {
            try { process.kill(Number(pid), 'SIGKILL'); } catch (_) {}
        }
    } catch (_) {}
}

function writeControl(env, ctl) {
    fs.writeFileSync(env.env.FAKE_CHROME_CONTROL, JSON.stringify(ctl));
}

function readState(env) {
    const files = fs.readdirSync(env.stateDir).filter(f => f.endsWith('.json'));
    if (!files.length) return null;
    try { return JSON.parse(fs.readFileSync(path.join(env.stateDir, files[0]), 'utf8')); } catch (_) { return null; }
}

function launchCount(env) {
    try {
        return fs.readFileSync(env.env.FAKE_CHROME_LOG, 'utf8').trim().split(/\r?\n/).filter(Boolean).length;
    } catch (_) { return 0; }
}

function launchArgs(env, n) {
    try {
        const lines = fs.readFileSync(env.env.FAKE_CHROME_LOG, 'utf8').trim().split(/\r?\n/).filter(Boolean);
        return lines[n - 1] ? JSON.parse(lines[n - 1]) : null;
    } catch (_) { return null; }
}

function isAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; }
}

async function waitFor(fn, timeoutMs, stepMs = 100) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const v = fn();
        if (v && typeof v.then === 'function') {
            if (await v) return v;
        } else if (v) {
            return v;
        }
        await sleep(stepMs);
    }
    return null;
}

function runSync(args, env) {
    return spawnSync(process.execPath, [ENGINE, ...args], { encoding: 'utf8', env, timeout: 60_000 });
}

// ── Case 1: one-shot launch ─────────────────────────────────────────────────
async function caseOneShot() {
    console.log('Case 1: one-shot launch (detached, port ready, no ownership state)');
    const env = mkEnv();
    writeControl(env, { stayMs: 4000, exitCode: 0 });
    const r = spawnSync('bash', [BRIDGE, 'chrome-debug', '--json'], { encoding: 'utf8', env: env.env, timeout: 60_000 });
    assert('engine exit 0', r.status === 0, `status=${r.status} stderr=${r.stderr.slice(0, 400)}`);
    assert('fake Chrome launched exactly once', launchCount(env) === 1, `count=${launchCount(env)}`);
    const args = launchArgs(env, 1);
    assert('launched with canonical profile', args && args.some(a => a === `--user-data-dir=${env.profileDir}`), JSON.stringify(args));
    assert('launched with port', args && args.some(a => a === `--remote-debugging-port=${env.port}`), JSON.stringify(args));
    assert('no ownership state written (one-shot)', readState(env) === null, JSON.stringify(readState(env)));
    const fakePid = (() => {
        try {
            const { execFileSync } = require('child_process');
            const out = execFileSync('lsof', ['-ti', `tcp:${env.port}`], { encoding: 'utf8' }).trim();
            return Number(out.split(/\r?\n/).pop());
        } catch (_) { return 0; }
    })();
    if (fakePid) { try { process.kill(fakePid, 'SIGKILL'); } catch (_) {} }
    fs.rmSync(env.root, { recursive: true, force: true });
}

// ── Case 2: daemon clean exit → no restart ──────────────────────────────────
async function caseDaemonCleanExit() {
    console.log('Case 2: daemon — clean Chrome exit ends supervision without restart');
    const env = mkEnv();
    writeControl(env, { stayMs: 6000, exitCode: 0 });
    const child = spawn('bash', [BRIDGE, 'chrome-debug', '--daemon', '--foreground'], { env: env.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const state = await waitFor(() => readState(env), 15_000);
    assert('ownership state established', !!state && state.supervisorPid > 0 && state.chromePid > 0, JSON.stringify(state));
    const portUp = await waitFor(() => cdPUp(env), 10_000);
    assert('fake Chrome served CDP', !!portUp);
    const code = await new Promise((resolve) => {
        child.on('exit', (c) => resolve(c));
        setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve('timeout'); }, 20_000);
    });
    assert('supervisor exited 0 after clean child exit', code === 0, `code=${code}`);
    assert('exactly one launch (no restart on clean exit)', launchCount(env) === 1, `count=${launchCount(env)}`);
    assert('state cleared after clean exit', readState(env) === null);
    assert('no restart message', !/Restarting Chrome/.test(out), out.slice(0, 500));
    fs.rmSync(env.root, { recursive: true, force: true });
}

// ── Case 3: daemon crash → bounded restart → clean exit ends supervision ────
async function caseDaemonCrashRestart() {
    console.log('Case 3: daemon — abnormal exit restarts once, then clean exit ends supervision');
    const env = mkEnv();
    writeControl(env, { stayMs: 500, exitCode: 7 });  // first launch crashes
    const child = spawn('bash', [BRIDGE, 'chrome-debug', '--daemon', '--foreground'], { env: env.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    await waitFor(() => readState(env), 15_000);
    // First launch crashes → supervisor backs off (300ms) and restarts.
    // Before the second launch reads its control file, switch it to clean.
    const secondLaunchSeen = await waitFor(() => launchCount(env) >= 2, 10_000);
    assert('second launch happened (restart)', !!secondLaunchSeen, `count=${launchCount(env)}`);
    writeControl(env, { stayMs: 800, exitCode: 0 });
    const code = await new Promise((resolve) => {
        child.on('exit', (c) => resolve(c));
        setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve('timeout'); }, 20_000);
    });
    assert('supervisor exited 0', code === 0, `code=${code}`);
    assert('exactly two launches (one bounded restart)', launchCount(env) === 2, `count=${launchCount(env)}`);
    assert('crash detected', /exited abnormally/.test(out), out.slice(0, 800));
    assert('restart logged', /Restarting Chrome/.test(out), out.slice(0, 800));
    assert('state cleared', readState(env) === null);
    fs.rmSync(env.root, { recursive: true, force: true });
}

// ── Case 4: --stop on owned supervisor ──────────────────────────────────────
async function caseStop() {
    console.log('Case 4: --stop stops only the validated owned supervisor/child');
    const env = mkEnv();
    writeControl(env, { stayMs: 60_000, exitCode: 0 });
    const child = spawn('bash', [BRIDGE, 'chrome-debug', '--daemon', '--foreground'], { env: env.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    const state = await waitFor(() => readState(env), 15_000);
    assert('ownership state established', !!state, JSON.stringify(state));
    const chromePid = state ? state.chromePid : 0;
    const portUp = await waitFor(() => cdPUp(env), 10_000);
    assert('fake Chrome served CDP', !!portUp);

    const stop = runSync(['--stop'], env.env);
    assert('--stop exit 0', stop.status === 0, `status=${stop.status} stderr=${stop.stderr.slice(0, 300)}`);
    assert('--stop reports stopped', /Stopping owned supervisor/.test(stop.stdout), stop.stdout.slice(0, 300));
    const cleared = await waitFor(() => readState(env) === null, 10_000);
    assert('state cleared', !!cleared);
    assert('Chrome child terminated', !isAlive(chromePid));
    const code = await new Promise((resolve) => {
        child.on('exit', (c) => resolve(c));
        setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve('timeout'); }, 10_000);
    });
    assert('supervisor exited', code === 0, `code=${code}`);
    assert('no restart after stop', launchCount(env) === 1, `count=${launchCount(env)}`);
    fs.rmSync(env.root, { recursive: true, force: true });
}

// ── Case 5: stale/foreign state → safe no-op ────────────────────────────────
async function caseStaleState() {
    console.log('Case 5: --stop with stale/foreign state is a safe no-op');
    const env = mkEnv();
    const eng = require(path.join(SCRIPTS, 'lib', 'chrome-debug-lifecycle.cjs'));
    const key = eng.stateKey(env.profileDir, env.port);
    const keyFile = path.join(env.stateDir, `chrome-debug-${key}.json`);
    fs.writeFileSync(keyFile, JSON.stringify({
        schemaVersion: 1,
        command: 'chrome-debug',
        mode: 'daemon',
        lifecycle: 'supervising',
        supervisorPid: 2_999_999,   // cannot exist
        supervisorStart: 'never',
        chromePid: 2_999_998,
        chromeStart: 'never',
        profile: env.profileDir,
        port: env.port,
        stateKey: key,
    }));
    const r = runSync(['--stop'], env.env);
    assert('exit 0 (safe no-op)', r.status === 0, `status=${r.status} stderr=${r.stderr.slice(0, 300)}`);
    assert('reports unvalidated ownership', /no validated ownership|stale/i.test(r.stdout), r.stdout.slice(0, 300));
    assert('stale state cleared', fs.readdirSync(env.stateDir).filter(f => f.endsWith('.json')).length === 0);
    assert('no Chrome launched', launchCount(env) === 0);
    fs.rmSync(env.root, { recursive: true, force: true });
}

// ── Case 6: production detached daemon (spawnSupervisorDetached) ────────────
async function caseDetachedDaemon() {
    console.log('Case 6: detached daemon (production path) — start, status, stop');
    const env = mkEnv();
    writeControl(env, { stayMs: 60_000, exitCode: 0 });
    const r = spawnSync('bash', [BRIDGE, 'chrome-debug', '--daemon'], { encoding: 'utf8', env: env.env, timeout: 60_000 });
    assert('daemon parent exit 0', r.status === 0, `status=${r.status} stderr=${r.stderr.slice(0, 400)}`);
    const state = await waitFor(() => readState(env), 15_000);
    assert('ownership state established by detached supervisor', !!state && state.supervisorPid > 0, JSON.stringify(state));
    assert('supervisor is a different process (detached)', state && state.supervisorPid !== process.pid, String(state && state.supervisorPid));
    const portUp = await waitFor(() => cdPUp(env), 10_000);
    assert('fake Chrome served CDP', !!portUp);
    const chromePid = state ? state.chromePid : 0;
    // --status must report owned.
    const st = runSync(['--status', '--json'], env.env);
    let statusJson = null;
    try { statusJson = JSON.parse(st.stdout); } catch (_) {}
    assert('--status exit 0', st.status === 0, st.stderr.slice(0, 200));
    assert('--status reports owned supervisor', statusJson && statusJson.ownership && statusJson.ownership.state === 'owned', st.stdout.slice(0, 300));
    // --stop must terminate the detached supervisor + child.
    const stop = runSync(['--stop'], env.env);
    assert('--stop exit 0', stop.status === 0, `status=${stop.status} stderr=${stop.stderr.slice(0, 300)}`);
    const cleared = await waitFor(() => readState(env) === null, 10_000);
    assert('state cleared after stop', !!cleared);
    const childGone = await waitFor(() => !isAlive(chromePid), 10_000);
    assert('detached supervisor terminated its child', !!childGone);
    fs.rmSync(env.root, { recursive: true, force: true });
}

// ── Case 7: stop during crash backoff still reaches the supervisor ──────────
async function caseStopDuringBackoff() {
    console.log('Case 7: --stop during crash backoff stops the supervisor (no respawn)');
    const env = mkEnv();
    writeControl(env, { stayMs: 400, exitCode: 9 });  // crash on every launch
    const child = spawn('bash', [BRIDGE, 'chrome-debug', '--daemon', '--foreground'], { env: env.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    await waitFor(() => readState(env), 15_000);
    // Wait until the first crash happened and the supervisor is in backoff
    // (child dead, state still present).
    const inBackoff = await waitFor(() => {
        const s = readState(env);
        return s && !isAlive(s.chromePid) ? s : null;
    }, 15_000);
    assert('supervisor in backoff with dead child', !!inBackoff, JSON.stringify(inBackoff));
    const launchesBeforeStop = launchCount(env);
    const stop = runSync(['--stop'], env.env);
    assert('--stop exit 0 during backoff', stop.status === 0, `status=${stop.status} stderr=${stop.stderr.slice(0, 300)}`);
    const cleared = await waitFor(() => readState(env) === null, 10_000);
    assert('state cleared (stop reached the supervisor)', !!cleared);
    const code = await new Promise((resolve) => {
        child.on('exit', (c) => resolve(c));
        setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve('timeout'); }, 10_000);
    });
    assert('supervisor exited', code === 0, `code=${code}`);
    // Backoff was 300ms base; give the loop time and confirm NO respawn.
    await sleep(1500);
    assert('no respawn after stop', launchCount(env) === launchesBeforeStop, `launches=${launchCount(env)} before=${launchesBeforeStop}`);
    fs.rmSync(env.root, { recursive: true, force: true });
}

(async () => {
    await caseOneShot();
    killFakeChromes();
    await caseDaemonCleanExit();
    killFakeChromes();
    await caseDaemonCrashRestart();
    killFakeChromes();
    await caseStop();
    killFakeChromes();
    await caseStaleState();
    killFakeChromes();
    await caseDetachedDaemon();
    killFakeChromes();
    await caseStopDuringBackoff();
    killFakeChromes();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    console.error('LIFECYCLE TEST CRASH:', e);
    process.exit(1);
});
