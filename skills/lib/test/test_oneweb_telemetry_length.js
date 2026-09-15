#!/usr/bin/env node
'use strict';

/**
 * Successful OneWeb runs must record response_length_chars from the
 * returned response. Resume-only assignment is not enough.
 */

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');
const oneWeb = require(path.join(ROOT, 'skills/AgentChat-OneWeb/index.js'));

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log('  PASS ' + name);
    } catch (e) {
        failed++;
        console.log('  FAIL ' + name + ' — ' + e.message);
    }
}

(async () => {
    await test('tryAllProviders success records response_length_chars', async () => {
        const response = 'MODEL-CHECK-OK';
        const page = {
            url: () => 'https://gemini.google.com/u/0/app',
            isClosed: () => false,
            close: async () => {},
        };
        const context = {
            pages: () => [],
            newPage: async () => page,
            grantPermissions: async () => {},
        };
        const browser = { isConnected: () => true, contexts: () => [context] };
        const ctx = { telemetry: { per_provider_ms: {}, response_length_chars: 0 } };
        const result = await oneWeb.tryAllProviders(browser, 'ping', ctx, {
            startFrom: 'gemini',
            singleAttempt: true,
            totalTimeout: 60_000,
            providerTimeout: 20_000,
            runners: {
                gemini: async () => ({ success: true, response }),
            },
        });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.response, response);
        assert.strictEqual(ctx.telemetry.response_length_chars, response.length);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
