#!/usr/bin/env node
'use strict';

/**
 * test_threads_registry.js — machine-local pinned-thread registry
 * (~/.agentchat/threads.json) and the Muse thread selection order:
 *
 *   R1  registryPath honors AGENTCHAT_HOME.
 *   R2  absent registry file → BUILTIN_THREADS fallback (company-main Muse
 *       thread stays discoverable on a fresh machine).
 *   R3  corrupt registry file → same fallback, error recorded.
 *   R4  pinThread writes valid JSON, upserts by provider+name.
 *   R5  default pin = most recently pinned (pinned_at desc; later file order
 *       breaks ties).
 *   R6  defaultMuseTargetUrl order: env > registry pin > builtin fallback.
 *   R7  CLI: --pin-muse-thread=<url>,name writes the registry;
 *       --show-muse-thread prints the active pinned URL (and the builtin
 *       fallback when no file exists).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const AGENTCHAT_ROOT = path.resolve(__dirname, '..', '..', '..');
const threads = require(path.join(AGENTCHAT_ROOT, 'skills', 'lib', 'threads'));
const { defaultMuseTargetUrl } = require(path.join(AGENTCHAT_ROOT, 'skills', 'AgentChat-OneWeb', 'index.js'));

const COMPANY_URL = 'https://muse.ai/thread/26242595-55a6-4263-9864-72e7dc71ab57';
const OTHER_UUID = '411d43f8-8092-45b9-86f2-b5e24da2e9c1';
const OTHER_URL = `https://muse.ai/thread/${OTHER_UUID}`;
const MUSE_NEW = 'https://muse.ai/thread/new';
const ONEWEB = path.join(AGENTCHAT_ROOT, 'skills', 'AgentChat-OneWeb', 'index.js');

let passed = 0, total = 0;
function ok(name, fn) {
    total++;
    try {
        fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ✗ ${name}\n    ${e && e.stack || e}`);
        process.exitCode = 1;
    }
}
function tmpHome() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-threads-'));
}

console.log('threads registry + Muse thread selection tests');

ok('R1: registryPath honors AGENTCHAT_HOME', () => {
    const p = threads.registryPath({ AGENTCHAT_HOME: '/tmp/xyz-home' });
    assert.strictEqual(p, path.join('/tmp/xyz-home', 'threads.json'));
});

ok('R2: absent file → builtin fallback with the standing company thread', () => {
    const reg = threads.loadRegistry({ AGENTCHAT_HOME: tmpHome() });
    assert.strictEqual(reg.source, 'builtin');
    const pin = threads.resolvePinnedThread('muse', { AGENTCHAT_HOME: tmpHome() });
    assert(pin, 'a muse pin must resolve from the builtin fallback');
    assert.strictEqual(pin.url, COMPANY_URL);
    assert.strictEqual(pin.name, 'company-main');
});

ok('R3: corrupt file → builtin fallback + error recorded', () => {
    const home = tmpHome();
    fs.writeFileSync(path.join(home, 'threads.json'), '{not json');
    const reg = threads.loadRegistry({ AGENTCHAT_HOME: home });
    assert.strictEqual(reg.source, 'builtin');
    assert(reg.error, 'parse error recorded');
    assert.strictEqual(threads.resolvePinnedThreadUrl('muse', { AGENTCHAT_HOME: home }), COMPANY_URL);
});

ok('R4: pinThread writes valid JSON and upserts by provider+name', () => {
    const home = tmpHome();
    threads.pinThread({ name: 'ops', provider: 'muse', url: OTHER_URL, pinned_at: '2026-10-22' }, { AGENTCHAT_HOME: home });
    const file = path.join(home, 'threads.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(parsed.version, 1);
    assert(Array.isArray(parsed.threads));
    // First pin persists alongside the builtin seed (absent file → builtin → upsert).
    assert.strictEqual(parsed.threads.length, 2);
    // Re-pin same provider+name replaces, does not duplicate.
    threads.pinThread({ name: 'ops', provider: 'muse', url: COMPANY_URL, pinned_at: '2026-10-23' }, { AGENTCHAT_HOME: home });
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(after.threads.filter(t => t.provider === 'muse' && t.name === 'ops').length, 1);
    assert.strictEqual(after.threads.find(t => t.name === 'ops').url, COMPANY_URL);
});

ok('R5: default pin = most recently pinned; ties broken by later file order', () => {
    const home = tmpHome();
    const reg = {
        version: 1,
        threads: [
            { name: 'old', provider: 'muse', url: COMPANY_URL, pinned_at: '2026-10-01' },
            { name: 'new', provider: 'muse', url: OTHER_URL, pinned_at: '2026-10-20' },
        ],
    };
    fs.writeFileSync(path.join(home, 'threads.json'), JSON.stringify(reg));
    assert.strictEqual(threads.resolvePinnedThreadUrl('muse', { AGENTCHAT_HOME: home }), OTHER_URL);
    // Equal pinned_at → the entry later in the file wins.
    reg.threads.push({ name: 'same-day', provider: 'muse', url: COMPANY_URL, pinned_at: '2026-10-20' });
    fs.writeFileSync(path.join(home, 'threads.json'), JSON.stringify(reg));
    assert.strictEqual(threads.resolvePinnedThreadUrl('muse', { AGENTCHAT_HOME: home }), COMPANY_URL);
    // Other providers never leak into the muse pin.
    assert.strictEqual(threads.resolvePinnedThread('chatgpt', { AGENTCHAT_HOME: home }), null);
});

ok('R6: defaultMuseTargetUrl order — env > registry pin > builtin fallback', () => {
    const savedEnv = process.env.AGENTCHAT_MUSE_URL;
    const savedHome = process.env.AGENTCHAT_HOME;
    try {
        const home = tmpHome();
        process.env.AGENTCHAT_HOME = home;
        // env beats the registry pin
        process.env.AGENTCHAT_MUSE_URL = 'main';
        threads.pinThread({ name: 'ops', provider: 'muse', url: OTHER_URL, pinned_at: '2026-10-22' });
        assert.strictEqual(defaultMuseTargetUrl(), 'https://muse.ai/', 'env wins over registry');
        // registry pin used when env is empty
        process.env.AGENTCHAT_MUSE_URL = '';
        assert.strictEqual(defaultMuseTargetUrl(), OTHER_URL, 'registry pin beats builtin fallback');
        // no file at all → builtin fallback (company-main), never a bare new thread
        fs.unlinkSync(path.join(home, 'threads.json'));
        assert.strictEqual(defaultMuseTargetUrl(), COMPANY_URL, 'builtin fallback is the company thread');
        // invalid pin in registry degrades to the adapter default (new thread)
        fs.writeFileSync(path.join(home, 'threads.json'), JSON.stringify({
            version: 1,
            threads: [{ name: 'bad', provider: 'muse', url: 'https://example.com/not-muse', pinned_at: '2026-10-22' }],
        }));
        assert.strictEqual(defaultMuseTargetUrl(), MUSE_NEW, 'invalid pin falls back to a new thread');
    } finally {
        if (savedEnv == null) delete process.env.AGENTCHAT_MUSE_URL; else process.env.AGENTCHAT_MUSE_URL = savedEnv;
        if (savedHome == null) delete process.env.AGENTCHAT_HOME; else process.env.AGENTCHAT_HOME = savedHome;
    }
});

ok('R7: CLI --pin-muse-thread writes the registry; --show-muse-thread prints the pin', () => {
    const home = tmpHome();
    const env = { ...process.env, AGENTCHAT_HOME: home };
    // --show-muse-thread with NO file → builtin fallback seed URL
    let r = spawnSync(process.execPath, [ONEWEB, '--show-muse-thread'], { env, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `show (builtin) exit 0, stderr: ${r.stderr}`);
    assert.strictEqual(r.stdout.trim(), COMPANY_URL, 'builtin fallback printed');
    // --pin-muse-thread=<url>,ops → writes registry, prints the URL
    r = spawnSync(process.execPath, [ONEWEB, `--pin-muse-thread=${OTHER_URL},ops`], { env, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `pin exit 0, stderr: ${r.stderr}`);
    assert.strictEqual(r.stdout.trim(), OTHER_URL);
    const written = JSON.parse(fs.readFileSync(path.join(home, 'threads.json'), 'utf8'));
    assert(written.threads.some(t => t.name === 'ops' && t.url === OTHER_URL), 'pin persisted');
    // --show-muse-thread now reflects the freshest pin (pinned_at = today ≥ seed date)
    r = spawnSync(process.execPath, [ONEWEB, '--show-muse-thread'], { env, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `show exit 0, stderr: ${r.stderr}`);
    assert.strictEqual(r.stdout.trim(), OTHER_URL, 'registry pin printed');
    // pinning "new" or a non-thread URL is a usage error (64), never a registry write
    r = spawnSync(process.execPath, [ONEWEB, '--pin-muse-thread=new'], { env, encoding: 'utf8' });
    assert.strictEqual(r.status, 64, `pin "new" rejected with EX_USAGE, got ${r.status}`);
});

console.log(`\n${passed}/${total} assertion groups passed`);
process.exit(process.exitCode || 0);
