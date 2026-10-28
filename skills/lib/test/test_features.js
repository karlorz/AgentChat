#!/usr/bin/env node
'use strict';

/**
 * FF-01 registry contract: precedence, inertness, invariant rules, doctor CLI.
 *
 * Every config-sensitive assertion passes explicit `{ localFile, env }` maps, so
 * the suite stays green when the ambient env carries e.g.
 * AGENTCHAT_DEEP_RESEARCH=1 or AGENTCHAT_KIMI_NO_THINK=1 (see scripts/test-flags.js).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const features = require(path.join(ROOT, 'skills/lib/features.js'));
const { PROVIDER_KEYS } = require(path.join(ROOT, 'skills/lib/providers/chain.js'));
const DOCTOR = path.join(ROOT, 'skills/lib/features-doctor.js');

const { FEATURE_FLAGS, EXCEPTIONS, checkInvariant, resolveSpecWithSource } = features;

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('  PASS ' + name);
    } catch (e) {
        failed++;
        console.log('  FAIL ' + name + ' — ' + e.message);
    }
}

const EMPTY = () => ({ localFile: {}, env: {} });

console.log('── features.js registry + resolver ──');

test('real registry passes checkInvariant', () => {
    assert.deepStrictEqual(checkInvariant(), []);
});

test('default-on experimental flag without an EXCEPTIONS entry is a violation', () => {
    const v = checkInvariant({
        flags: [{ id: 'exp', key: 'AGENTCHAT_EXP', stage: 'experimental', defaultEnabled: true }],
        exceptions: [],
        providerKeys: [],
    });
    assert.ok(v.some((s) => /exp/.test(s) && /experimental/.test(s)), JSON.stringify(v));
});

test('duplicate key is a violation', () => {
    const v = checkInvariant({
        flags: [
            { id: 'one', key: 'AGENTCHAT_DUP', stage: 'stable', defaultEnabled: false },
            { id: 'two', key: 'AGENTCHAT_DUP', stage: 'stable', defaultEnabled: false },
        ],
        exceptions: [],
        providerKeys: [],
    });
    assert.ok(v.some((s) => /duplicate key/.test(s) && /AGENTCHAT_DUP/.test(s)), JSON.stringify(v));
});

test('EXCEPTIONS entry with no note is a violation', () => {
    const v = checkInvariant({
        flags: [{ id: 'exp', key: 'AGENTCHAT_EXP', stage: 'experimental', defaultEnabled: true }],
        exceptions: [{ id: 'exp' }],
        providerKeys: [],
    });
    assert.ok(v.some((s) => /exp/.test(s) && /note/.test(s)), JSON.stringify(v));
});

test('provider drift is a violation in both directions', () => {
    const flags = [
        ...FEATURE_FLAGS,
        { id: 'providerGhost', key: 'PROVIDER_GHOST', stage: 'stable', defaultEnabled: true },
    ];
    const v = checkInvariant({
        flags,
        exceptions: EXCEPTIONS,
        providerKeys: [...PROVIDER_KEYS, 'newcoin'],
    });
    assert.ok(v.some((s) => /newcoin/.test(s) && /missing/.test(s)), JSON.stringify(v));
    assert.ok(v.some((s) => /PROVIDER_GHOST/.test(s)), JSON.stringify(v));
});

test('precedence: default < local file < env, with sources', () => {
    const key = 'AGENTCHAT_DEEP_RESEARCH';
    assert.deepStrictEqual(resolveSpecWithSource({ id: 'deepResearch', key, stage: 'stable', defaultEnabled: false }, EMPTY()),
        { enabled: false, source: 'default' });
    assert.deepStrictEqual(resolveSpecWithSource({ id: 'deepResearch', key, stage: 'stable', defaultEnabled: false },
        { localFile: { deepResearch: true }, env: {} }), { enabled: true, source: 'local-file' });
    assert.deepStrictEqual(resolveSpecWithSource({ id: 'deepResearch', key, stage: 'stable', defaultEnabled: false },
        { localFile: { deepResearch: true }, env: { [key]: '0' } }), { enabled: false, source: 'env' });
    assert.deepStrictEqual(features.resolveWithSource(key, EMPTY()), { enabled: false, source: 'default' });
    assert.strictEqual(features.resolve(key, { localFile: {}, env: { [key]: ' ON ' } }), true);
});

test('bad env value throws, names the key, and does not echo the value', () => {
    const key = 'AGENTCHAT_DEEP_RESEARCH';
    assert.throws(
        () => features.resolve(key, { localFile: {}, env: { [key]: 'maybe-secret' } }),
        (e) => e instanceof Error && e.message.includes(key) && !e.message.includes('maybe-secret')
    );
});

test('removed is inert against both maps', () => {
    const spec = { id: 'gone', key: 'AGENTCHAT_GONE', stage: 'removed', defaultEnabled: true };
    assert.deepStrictEqual(
        resolveSpecWithSource(spec, { localFile: { gone: false }, env: { AGENTCHAT_GONE: '0' } }),
        { enabled: true, source: 'default' }
    );
});

test('ids and keys are unique', () => {
    assert.strictEqual(new Set(FEATURE_FLAGS.map((f) => f.id)).size, FEATURE_FLAGS.length);
    assert.strictEqual(new Set(FEATURE_FLAGS.map((f) => f.key)).size, FEATURE_FLAGS.length);
});

test('empty config reproduces compiled defaults for every flag', () => {
    for (const flag of FEATURE_FLAGS) {
        assert.strictEqual(features.resolve(flag.key, EMPTY()), flag.defaultEnabled, flag.id);
    }
});

test('provider entries equal PROVIDER_KEYS exactly, both directions', () => {
    const registered = FEATURE_FLAGS.filter((f) => f.key.startsWith('PROVIDER_'))
        .map((f) => f.key.slice('PROVIDER_'.length).toLowerCase())
        .sort();
    assert.deepStrictEqual(registered, [...PROVIDER_KEYS].sort());
});

console.log('\n── features-doctor CLI ──');

test('doctor exits 0 with invariant ok and one row per registry entry', () => {
    const r = spawnSync('node', [DOCTOR], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, AGENTCHAT_FEATURES_REGISTRY_MODULE: '' },
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('invariant: ok'), r.stdout);
    assert.ok(r.stdout.includes('AGENTCHAT_DISABLED: documented, not read by code'), r.stdout);
    const ids = new Set(FEATURE_FLAGS.map((f) => f.id));
    const rows = r.stdout.split('\n').filter((line) => ids.has(line.split(' | ')[0]));
    assert.strictEqual(rows.length, FEATURE_FLAGS.length);
});

test('doctor exits 1 on a broken registry fixture', () => {
    const dir = path.join(os.tmpdir(), `ff01-broken-${process.pid}`);
    fs.mkdirSync(dir, { recursive: true });
    const mod = path.join(dir, 'registry.js');
    fs.writeFileSync(mod, [
        "'use strict';",
        'module.exports = {',
        "    FEATURE_FLAGS: [{ id: 'brokenExp', key: 'AGENTCHAT_BROKEN_EXP', stage: 'experimental', defaultEnabled: true }],",
        '    EXCEPTIONS: [],',
        '};',
        '',
    ].join('\n'));

    const r = spawnSync('node', [DOCTOR], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, AGENTCHAT_FEATURES_REGISTRY_MODULE: mod },
    });
    fs.rmSync(dir, { recursive: true, force: true });
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.ok(r.stdout.includes('invariant: FAILED'), r.stdout);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
