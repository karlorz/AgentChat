/**
 * Chrome CDP lifecycle — dispatch and contract tests.
 *
 * Verifies the Superpowers-style helper bridge (run-helper.cmd → bash →
 * extensionless scripts/chrome-debug → the shared Node engine) and the
 * engine's configuration contract:
 *   1. The bridge forwards arguments intact and the engine emits JSON.
 *   2. CHROME_PROFILE wins over CHROME_DEBUG_PROFILE; diagnostics report
 *      the winning source.
 *   3. CDP_PORT wins over CHROME_DEBUG_PORT.
 *   4. State keys are deterministic and profile+port scoped.
 *   5. --dry-run never launches Chrome.
 *   6. --stop with no state is a safe no-op (exit 0, nothing killed).
 *   7. Static contract for the Windows half: run-helper.cmd resolves Git
 *      Bash locations, fails non-zero without Bash; win32 adapter uses
 *      owned-tree termination and discovers Chrome/Chromium/Edge.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const ENGINE = path.join(SCRIPTS, 'lib', 'chrome-debug-lifecycle.cjs');
const BRIDGE = path.join(SCRIPTS, 'run-helper.cmd');
const HELPER = path.join(SCRIPTS, 'chrome-debug');
const WIN_ADAPTER = path.join(SCRIPTS, 'lib', 'win32-lifecycle-adapter.cjs');

let pass = 0, fail = 0;
const assert = (name, cond, detail = '') => {
    if (cond) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name, detail); }
};

function tempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function baseEnv() {
    return {
        ...process.env,
        CHROME_DEBUG_ENV_SKIP: '1',   // no repo .env interference
        CHROME_DEBUG_STATE_DIR: tempDir('agentchat-state-'),
        CHROME_PROFILE: '',
        CHROME_DEBUG_PROFILE: '',
        CDP_PORT: '',
        CHROME_DEBUG_PORT: '',
        HEADLESS: '',
        CHROME: '',
        CHROMIUM_PATH: '',
        AGENTCHAT_SCRIPTS_DIR: '',
        PROXY_SERVER: '',
    };
}

function runEngine(args, env) {
    return spawnSync(process.execPath, [ENGINE, ...args], { encoding: 'utf8', env });
}

// ── 1. Bridge dispatch + JSON contract ──────────────────────────────────────
{
    console.log('Case 1: run-helper.cmd bridge forwards to the engine (POSIX branch)');
    const env = baseEnv();
    const r = spawnSync('bash', [BRIDGE, 'chrome-debug', '--dry-run', '--json'], { encoding: 'utf8', env });
    assert('bridge exits 0', r.status === 0, `status=${r.status} stderr=${r.stderr.slice(0, 300)}`);
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch (_) {}
    assert('output is valid JSON', !!parsed, r.stdout.slice(0, 300));
    assert('contract version v3', parsed && parsed.chromeDebugContract === 'v3', String(parsed && parsed.chromeDebugContract));
    assert('has profileDir + debugPort', parsed && parsed.profileDir && parsed.debugPort === 9222);
    assert('reports profile source', parsed && typeof parsed.profileSource === 'string');
    const stateFiles = fs.existsSync(env.CHROME_DEBUG_STATE_DIR)
        ? fs.readdirSync(env.CHROME_DEBUG_STATE_DIR).filter(f => f.endsWith('.json'))
        : [];
    assert('dry-run does not launch (no state files)', stateFiles.length === 0, stateFiles.join(','));
    fs.rmSync(env.CHROME_DEBUG_STATE_DIR, { recursive: true, force: true });
}

// ── 2. Profile precedence ───────────────────────────────────────────────────
{
    console.log('Case 2: CHROME_PROFILE wins over CHROME_DEBUG_PROFILE');
    const env = baseEnv();
    env.CHROME_PROFILE = '/tmp/agentchat-test-canonical';
    env.CHROME_DEBUG_PROFILE = '/tmp/agentchat-test-alias';
    const r = runEngine(['--dry-run', '--json'], env);
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch (_) {}
    assert('exit 0', r.status === 0, r.stderr.slice(0, 200));
    assert('profileDir is CHROME_PROFILE', parsed && parsed.profileDir === '/tmp/agentchat-test-canonical', String(parsed && parsed.profileDir));
    assert('profileSource reported', parsed && parsed.profileSource === 'CHROME_PROFILE', String(parsed && parsed.profileSource));
    assert('alias not used', parsed && !parsed.profileDir.includes('test-alias'));
    // Flip: only the alias set → used, with source reported.
    env.CHROME_PROFILE = '';
    const r2 = runEngine(['--dry-run', '--json'], env);
    let parsed2 = null;
    try { parsed2 = JSON.parse(r2.stdout); } catch (_) {}
    assert('fallback alias used', parsed2 && parsed2.profileDir === '/tmp/agentchat-test-alias', String(parsed2 && parsed2.profileDir));
    assert('alias source reported', parsed2 && parsed2.profileSource === 'CHROME_DEBUG_PROFILE', String(parsed2 && parsed2.profileSource));
    fs.rmSync(env.CHROME_DEBUG_STATE_DIR, { recursive: true, force: true });
}

// ── 3. Port precedence ──────────────────────────────────────────────────────
{
    console.log('Case 3: CDP_PORT wins over CHROME_DEBUG_PORT');
    const env = baseEnv();
    env.CDP_PORT = '9333';
    env.CHROME_DEBUG_PORT = '9444';
    const r = runEngine(['--dry-run', '--json'], env);
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch (_) {}
    assert('exit 0', r.status === 0, r.stderr.slice(0, 200));
    assert('port is CDP_PORT', parsed && parsed.debugPort === 9333, String(parsed && parsed.debugPort));
    assert('port source reported', parsed && parsed.portSource === 'CDP_PORT', String(parsed && parsed.portSource));
    env.CDP_PORT = '';
    const r2 = runEngine(['--dry-run', '--json'], env);
    let parsed2 = null;
    try { parsed2 = JSON.parse(r2.stdout); } catch (_) {}
    assert('alias port used', parsed2 && parsed2.debugPort === 9444, String(parsed2 && parsed2.debugPort));
    fs.rmSync(env.CHROME_DEBUG_STATE_DIR, { recursive: true, force: true });
}

// ── 4. State key determinism ────────────────────────────────────────────────
{
    console.log('Case 4: state key is deterministic and scoped');
    const env = baseEnv();
    const r1 = runEngine(['--print-config', '--json'], env);
    const keyScript = `
        const eng = require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'chrome-debug-lifecycle.cjs'))});
        console.log(eng.stateKey('/Users/x/Profile A', '9222'));
        console.log(eng.stateKey('/Users/x/Profile A', '9222'));
        console.log(eng.stateKey('/Users/x/Profile B', '9222'));
        console.log(eng.stateKey('/Users/x/Profile A', '9333'));
    `;
    const k = spawnSync(process.execPath, ['-e', keyScript], { encoding: 'utf8', env: baseEnv() });
    const [a, b, c, d] = k.stdout.trim().split(/\r?\n/);
    assert('exit 0', k.status === 0, k.stderr.slice(0, 200));
    assert('same profile+port → same key', a === b && !!a, `${a} vs ${b}`);
    assert('different profile → different key', a !== c, `${a} vs ${c}`);
    assert('different port → different key', a !== d, `${a} vs ${d}`);
    assert('engine prints config JSON', r1.status === 0 && r1.stdout.includes('chromeDebugContract'), r1.stderr.slice(0, 200));
    fs.rmSync(env.CHROME_DEBUG_STATE_DIR, { recursive: true, force: true });
}

// ── 5. --stop with no state is a safe no-op ─────────────────────────────────
{
    console.log('Case 5: --stop without state is a safe no-op');
    const env = baseEnv();
    env.CHROME_PROFILE = path.join(tempDir('agentchat-profile-'), 'p');
    const r = runEngine(['--stop'], env);
    assert('exit 0', r.status === 0, `status=${r.status} stderr=${r.stderr.slice(0, 200)}`);
    assert('mentions nothing to stop', /nothing to stop/i.test(r.stdout), r.stdout.slice(0, 200));
    assert('no state file created', !fs.readdirSync(env.CHROME_DEBUG_STATE_DIR).some(f => f.endsWith('.json')));
    fs.rmSync(env.CHROME_DEBUG_STATE_DIR, { recursive: true, force: true });
    fs.rmSync(path.dirname(env.CHROME_PROFILE), { recursive: true, force: true });
}

// ── 6. Windows contract (static; no Windows runner here) ────────────────────
{
    console.log('Case 6: Windows bridge + adapter static contract');
    const bridgeSrc = fs.readFileSync(BRIDGE, 'utf8');
    assert('run-helper.cmd is polyglot (bash branch present)', bridgeSrc.includes('exec bash') || bridgeSrc.includes('POSIX branch'), '');
    assert('run-helper.cmd checks standard Git Bash locations', /Program Files.*Git.*bin[\\/]bash\.exe/.test(bridgeSrc), '');
    assert('run-helper.cmd checks PATH bash fallback', bridgeSrc.includes('where bash'), '');
    assert('run-helper.cmd fails non-zero without Bash', /exit \/b 1/.test(bridgeSrc) && /Git Bash not found/.test(bridgeSrc), '');
    assert('helper is extensionless', !HELPER.endsWith('.sh'), HELPER);
    assert('helper forwards to the engine', fs.readFileSync(HELPER, 'utf8').includes('chrome-debug-lifecycle.cjs'), '');
    const winSrc = fs.readFileSync(WIN_ADAPTER, 'utf8');
    assert('win32 adapter uses taskkill /T owned-tree termination', /taskkill[^\n]*\/T/.test(winSrc), '');
    assert('win32 adapter discovers Chrome/Chromium/Edge', /msedge\.exe/.test(winSrc) && /Chromium/.test(winSrc), '');
    assert('win32 adapter builds WMI create command', winSrc.includes('Win32_Process -MethodName Create'), '');
    assert('win32 adapter quotes argv (no name-only matching)', winSrc.includes('winArgQuote'), '');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
