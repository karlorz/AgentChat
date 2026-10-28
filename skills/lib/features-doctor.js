#!/usr/bin/env node
/**
 * Feature-flag doctor (FF-01).
 *
 * Prints the registry with effective values, then an invariant verdict.
 * Reads only the gitignored repo-root .features.local.json (if present) and
 * process env — no network, no CDP, no Chrome. Env values are never printed;
 * only the resolved boolean is.
 *
 * Test-only hook: AGENTCHAT_FEATURES_REGISTRY_MODULE points at a module that
 * exports FEATURE_FLAGS/EXCEPTIONS, so the failure path can be exercised
 * without mutating the real registry.
 */

'use strict';

const path = require('path');
const features = require('./features');

const ROOT = path.resolve(__dirname, '../..');
const LOCAL_FILE = path.join(ROOT, features.FEATURE_FLAGS_LOCAL_FILE);

function loadRegistry() {
    const override = (process.env.AGENTCHAT_FEATURES_REGISTRY_MODULE || '').trim();
    if (!override) return features;
    const mod = require(path.resolve(ROOT, override));
    return {
        FEATURE_FLAGS: mod.FEATURE_FLAGS || [],
        EXCEPTIONS: mod.EXCEPTIONS || [],
        readLocalFile: features.readLocalFile,
        resolveSpecWithSource: features.resolveSpecWithSource,
        checkInvariant: features.checkInvariant,
    };
}

function main() {
    let registry;
    try {
        registry = loadRegistry();
    } catch (e) {
        process.stderr.write(`feature flags: cannot load registry module: ${e.message}\n`);
        return 1;
    }

    let local;
    try {
        local = registry.readLocalFile(LOCAL_FILE);
    } catch (e) {
        process.stderr.write(`${e.message}\n`);
        return 1;
    }

    const flags = registry.FEATURE_FLAGS;
    const overrides = { localFile: local, env: process.env };

    process.stdout.write('id | key | stage | default | effective | source\n');

    let resolveError = false;
    for (const flag of flags) {
        let r;
        try {
            r = registry.resolveSpecWithSource(flag, overrides);
        } catch (e) {
            // Never echo the offending env value.
            process.stderr.write(`${e.message}\n`);
            process.stdout.write(`${flag.id} | ${flag.key} | ${flag.stage} | ${flag.defaultEnabled} | error | error\n`);
            resolveError = true;
            continue;
        }
        process.stdout.write(
            `${flag.id} | ${flag.key} | ${flag.stage} | ${flag.defaultEnabled} | ${r.enabled} | ${r.source}\n`
        );
    }

    process.stdout.write('AGENTCHAT_DISABLED: documented, not read by code\n');

    const violations = registry.checkInvariant({
        flags,
        exceptions: registry.EXCEPTIONS,
    });
    if (resolveError) {
        violations.push('resolve error while evaluating the registry');
    }

    if (violations.length === 0) {
        process.stdout.write('invariant: ok\n');
        return 0;
    }
    for (const v of violations) process.stderr.write(`violation: ${v}\n`);
    process.stdout.write(`invariant: FAILED (${violations.length})\n`);
    return 1;
}

process.exit(main());
