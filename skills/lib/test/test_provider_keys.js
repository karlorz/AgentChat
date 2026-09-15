#!/usr/bin/env node
'use strict';

/**
 * IndependentTasks must fail loud when PROVIDER_KEYS is missing.
 * A stale ~/.agents/skills/lib/providers/chain.js that only exports
 * PROVIDER_CHAIN used to throw: Cannot read properties of undefined (reading 'includes').
 */

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');
const independent = require(path.join(ROOT, 'skills/AgentChat-IndependentTasks/index.js'));

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

test('resolveProviderKeys is exported', () => {
    assert.strictEqual(typeof independent.resolveProviderKeys, 'function');
});

test('missing PROVIDER_KEYS throws a repair hint, not includes-on-undefined', () => {
    assert.throws(
        () => independent.resolveProviderKeys(undefined),
        (e) => e && e.code === 'ERR_PROVIDER_KEYS'
            && /PROVIDER_KEYS missing/.test(e.message)
            && /refresh/i.test(e.message)
            && !/includes/.test(e.message)
    );
});

test('empty PROVIDER_KEYS throws the same repair hint', () => {
    assert.throws(
        () => independent.resolveProviderKeys([]),
        (e) => e && e.code === 'ERR_PROVIDER_KEYS' && /PROVIDER_KEYS missing/.test(e.message)
    );
});

test('valid PROVIDER_KEYS are returned unchanged', () => {
    const keys = ['gemini', 'chatgpt'];
    assert.strictEqual(independent.resolveProviderKeys(keys), keys);
});

test('IndependentTasks FALLBACK_CHAIN is a non-empty array on a current tree', () => {
    assert.ok(Array.isArray(independent.FALLBACK_CHAIN));
    assert.ok(independent.FALLBACK_CHAIN.length > 0);
    assert.ok(independent.FALLBACK_CHAIN.includes('gemini'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
