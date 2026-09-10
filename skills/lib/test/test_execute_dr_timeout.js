#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');
const { _effectiveCallTimeoutMs } = require(path.join(ROOT, 'skills/lib/execute.js'));

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

function clearDrEnv() {
    delete process.env.AGENTCHAT_DEEP_RESEARCH;
    for (const k of Object.keys(process.env)) {
        if (/^AGENTCHAT_[A-Z]+_DEEP_RESEARCH$/.test(k)) delete process.env[k];
    }
}

(() => {
    console.log('── execute.js effectiveCallTimeoutMs (DR-aware call budget) ──');
    clearDrEnv();

    test('plain provider, no env: base timeout passes through', () => {
        assert.strictEqual(_effectiveCallTimeoutMs('qwen', 180_000), 180_000);
    });

    test('millisecond clamp floor: sub-10s slices clamp to 10000 (budget contract)', () => {
        assert.strictEqual(_effectiveCallTimeoutMs('qwen', 8_500), 10_000);
    });

    test('garbage timeout clamps to floor, never NaN', () => {
        assert.strictEqual(_effectiveCallTimeoutMs('qwen', NaN), 10_000);
        assert.strictEqual(_effectiveCallTimeoutMs('qwen', undefined), 10_000);
    });

    test('explicit callOpts.deepResearch=true raises to 1800s', () => {
        assert.strictEqual(_effectiveCallTimeoutMs('qwen', 180_000, { deepResearch: true }), 1_800_000);
    });

    test('per-provider env (AGENTCHAT_QWEN_DEEP_RESEARCH=1) raises qwen but not doubao', () => {
        process.env.AGENTCHAT_QWEN_DEEP_RESEARCH = '1';
        try {
            assert.strictEqual(_effectiveCallTimeoutMs('qwen', 180_000), 1_800_000);
            assert.strictEqual(_effectiveCallTimeoutMs('doubao', 180_000), 180_000);
        } finally {
            delete process.env.AGENTCHAT_QWEN_DEEP_RESEARCH;
        }
    });

    test('global env (AGENTCHAT_DEEP_RESEARCH=1) raises any provider', () => {
        process.env.AGENTCHAT_DEEP_RESEARCH = '1';
        try {
            assert.strictEqual(_effectiveCallTimeoutMs('doubao', 180_000), 1_800_000);
            assert.strictEqual(_effectiveCallTimeoutMs('gemini', 60_000), 1_800_000);
        } finally {
            delete process.env.AGENTCHAT_DEEP_RESEARCH;
        }
    });

    test('env value other than "1" does not activate DR', () => {
        process.env.AGENTCHAT_QWEN_DEEP_RESEARCH = 'true';
        try {
            assert.strictEqual(_effectiveCallTimeoutMs('qwen', 180_000), 180_000);
        } finally {
            delete process.env.AGENTCHAT_QWEN_DEEP_RESEARCH;
        }
    });

    test('a caller budget already above the DR floor is kept (Math.max)', () => {
        process.env.AGENTCHAT_DEEP_RESEARCH = '1';
        try {
            assert.strictEqual(_effectiveCallTimeoutMs('qwen', 3_600_000), 3_600_000);
        } finally {
            delete process.env.AGENTCHAT_DEEP_RESEARCH;
        }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
