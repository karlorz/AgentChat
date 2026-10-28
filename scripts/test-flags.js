#!/usr/bin/env node
'use strict';

/**
 * Flag legs: run the suites that observe a flag both ways.
 *
 * `npm test` runs every suite with whatever env the caller has. A flag that is
 * only ever exercised on one side can regress silently, so each leg below pins
 * one env var and re-runs the suites that read it. Deterministic, no network.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SUITE_DIR = path.join(ROOT, 'skills', 'lib', 'test');
const OPTIONAL_DEPS = ['jsdom', 'playwright-core'];

const LEGS = [
    {
        env: { AGENTCHAT_DEEP_RESEARCH: '1' },
        suites: ['test_features.js', 'test_execute_dr_timeout.js', 'test_chatgpt_composer_toggles.js'],
    },
    {
        env: { AGENTCHAT_DEEP_RESEARCH: '0' },
        suites: ['test_features.js', 'test_execute_dr_timeout.js', 'test_chatgpt_composer_toggles.js'],
    },
    {
        env: { AGENTCHAT_KIMI_NO_THINK: '1' },
        suites: ['test_features.js', 'test_kimi_modes.js', 'test_chatgpt_composer_toggles.js'],
    },
    {
        env: { AGENTCHAT_KIMI_NO_THINK: '0' },
        suites: ['test_features.js', 'test_kimi_modes.js', 'test_chatgpt_composer_toggles.js'],
    },
];

function missingDepsFor(file) {
    const src = fs.readFileSync(path.join(SUITE_DIR, file), 'utf8');
    return OPTIONAL_DEPS.filter((dep) => {
        const referenced =
            new RegExp(`require\\(['"]${dep}['"]\\)`).test(src) ||
            /AgentChat-OneWeb\/index\.js/.test(src);
        if (!referenced) return false;
        try {
            require.resolve(dep, { paths: [ROOT] });
            return false;
        } catch (_) {
            return true;
        }
    });
}

let failed = 0;
let skipped = 0;

for (const leg of LEGS) {
    const label = Object.entries(leg.env).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`\n── ${label} ──`);
    for (const file of leg.suites) {
        const missing = missingDepsFor(file);
        if (missing.length) {
            console.log(`SKIP  ${file}  (missing: ${missing.join(', ')} — run \`npm install\` to enable)`);
            skipped++;
            continue;
        }
        const res = spawnSync('node', [path.join(SUITE_DIR, file)], {
            cwd: ROOT,
            stdio: 'inherit',
            env: { ...process.env, ...leg.env },
        });
        if (res.status !== 0) {
            console.log(`FAIL  ${file}  (exit ${res.status})`);
            failed++;
        } else {
            console.log(`PASS  ${file}`);
        }
    }
}

console.log(`\n${LEGS.length} legs, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
