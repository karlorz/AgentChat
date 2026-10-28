/**
 * Feature-flag registry + resolver (FF-01).
 *
 * Metadata only. Every entry describes behavior that already ships: the
 * adapters read these env vars directly and this module does not stand in
 * their path. The registry exists so `features-doctor` can report effective
 * values and `checkInvariant` can reject default-on experiments.
 *
 * Precedence: compiled default < .features.local.json < process env.
 * `removed` is inert — the compiled default wins over both maps.
 */

'use strict';

const fs = require('fs');
const { PROVIDER_KEYS } = require('./providers/chain');

const FEATURE_FLAGS_LOCAL_FILE = '.features.local.json';

/** Stages allowed to ship default-on without an EXCEPTIONS entry. */
const DEFAULT_ON_STAGES = new Set(['stable', 'removed']);

const ENV_TRUE = new Set(['1', 'true', 'yes', 'on']);
const ENV_FALSE = new Set(['0', 'false', 'no', 'off']);

function _flag(id, key) {
    return Object.freeze({ id, key, stage: 'stable', defaultEnabled: false });
}

const _PROVIDERS = ['chatgpt', 'claude', 'grok', 'kimi', 'qwen'];

const _GLOBAL_FLAGS = [
    _flag('deepResearch', 'AGENTCHAT_DEEP_RESEARCH'),
    _flag('geminiNoMcpMention', 'AGENTCHAT_GEMINI_NO_MCP_MENTION'),
    _flag('chatgptResumeOnTimeout', 'AGENTCHAT_CHATGPT_RESUME_ON_TIMEOUT'),
    // Security-relaxing: permits image fetches from private/loopback hosts. Opt-in only.
    _flag('allowPrivateImageHosts', 'AGENTCHAT_ALLOW_PRIVATE_IMAGE_HOSTS'),
    _flag('downloadProviderAssets', 'AGENTCHAT_DOWNLOAD_PROVIDER_ASSETS'),
    _flag('noAutostart', 'AGENTCHAT_NO_AUTOSTART'),
    ..._PROVIDERS.map((p) => _flag(
        'deepResearch' + p.charAt(0).toUpperCase() + p.slice(1),
        `AGENTCHAT_${p.toUpperCase()}_DEEP_RESEARCH`
    )),
    ..._PROVIDERS.map((p) => _flag(
        'noThink' + p.charAt(0).toUpperCase() + p.slice(1),
        `AGENTCHAT_${p.toUpperCase()}_NO_THINK`
    )),
    ...['chatgpt', 'claude', 'grok', 'qwen'].map((p) => _flag(
        'noWebSearch' + p.charAt(0).toUpperCase() + p.slice(1),
        `AGENTCHAT_${p.toUpperCase()}_NO_WEB_SEARCH`
    )),
];

function _providerFlag(key) {
    return Object.freeze({
        id: 'provider' + key.charAt(0).toUpperCase() + key.slice(1),
        key: `PROVIDER_${key.toUpperCase()}`,
        stage: key === 'muse' ? 'experimental' : 'stable',
        defaultEnabled: true,
    });
}

/** Frozen registry: 20 global flags, then one entry per PROVIDER_KEYS in chain order. */
const FEATURE_FLAGS = Object.freeze(
    [..._GLOBAL_FLAGS, ...PROVIDER_KEYS.map(_providerFlag)].map((f) => Object.freeze(f))
);

const EXCEPTIONS = Object.freeze([
    Object.freeze({
        id: 'providerMuse',
        note: 'draft adapter already in chain; default-on predates FF-01; Karl decides promotion or default-off',
    }),
]);

/**
 * Read the opt-in local override map.
 * Missing file -> {}; invalid JSON -> Error naming the path.
 */
function readLocalFile(filePath) {
    if (!filePath) return {};
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        if (e && e.code === 'ENOENT') return {};
        throw new Error(`feature flags: cannot read local file ${filePath}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        throw new Error(`feature flags: invalid JSON in local file ${filePath}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`feature flags: local file ${filePath} must contain a JSON object`);
    }
    return parsed;
}

/** Parse an env value; never includes the value in the error (it may be secret-shaped). */
function _envBool(key, raw) {
    const v = String(raw).trim().toLowerCase();
    if (ENV_TRUE.has(v)) return true;
    if (ENV_FALSE.has(v)) return false;
    throw new Error(
        `feature flag ${key}: unrecognized env value (expected 1/true/yes/on or 0/false/no/off)`
    );
}

function _localBool(spec, raw) {
    if (typeof raw === 'boolean') return raw;
    throw new Error(`feature flag ${spec.id || spec.key}: local file value must be true or false`);
}

function _has(map, prop) {
    return Object.prototype.hasOwnProperty.call(map, prop);
}

/**
 * Resolve any flag spec (`{ id, key, stage, defaultEnabled }`) against maps.
 * @returns {{ enabled: boolean, source: 'default'|'local-file'|'env' }}
 */
function resolveSpecWithSource(spec, overrides) {
    if (!spec || typeof spec.key !== 'string' || !spec.key) {
        throw new Error('feature flag: resolveSpec requires a spec with a string key');
    }
    const o = overrides || {};
    const local = o.localFile || {};
    const env = o.env || {};

    if (spec.stage === 'removed') {
        return { enabled: spec.defaultEnabled === true, source: 'default' };
    }
    if (_has(env, spec.key)) {
        return { enabled: _envBool(spec.key, env[spec.key]), source: 'env' };
    }
    if (spec.id && _has(local, spec.id)) {
        return { enabled: _localBool(spec, local[spec.id]), source: 'local-file' };
    }
    // Env-style key accepted as well, so a pasted export name works verbatim.
    if (_has(local, spec.key)) {
        return { enabled: _localBool(spec, local[spec.key]), source: 'local-file' };
    }
    return { enabled: spec.defaultEnabled === true, source: 'default' };
}

function resolveSpec(spec, overrides) {
    return resolveSpecWithSource(spec, overrides).enabled;
}

function findFlag(key) {
    return FEATURE_FLAGS.find((f) => f.key === key) || null;
}

/** Resolve a registered env key. Unknown keys throw (naming the key). */
function resolveWithSource(key, overrides) {
    const spec = findFlag(key);
    if (!spec) throw new Error(`feature flag: unknown key ${key}`);
    return resolveSpecWithSource(spec, overrides);
}

function resolve(key, overrides) {
    return resolveWithSource(key, overrides).enabled;
}

function _providerKeyOf(providerKey) {
    return `PROVIDER_${String(providerKey).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/**
 * Structural checks over a registry. Accepts injected registries so tests can
 * prove each rule fires. Empty array means ok.
 */
function checkInvariant(opts) {
    const o = opts || {};
    const flags = Array.isArray(o.flags) ? o.flags : FEATURE_FLAGS;
    const exceptions = Array.isArray(o.exceptions) ? o.exceptions : EXCEPTIONS;
    const providerKeys = Array.isArray(o.providerKeys) ? o.providerKeys : PROVIDER_KEYS;
    const out = [];

    const exempted = new Set();
    for (const ex of exceptions) {
        const id = ex && ex.id;
        if (typeof id !== 'string' || !id) {
            out.push('EXCEPTIONS entry with no id');
            continue;
        }
        exempted.add(id);
        if (typeof ex.note !== 'string' || !ex.note.trim()) {
            out.push(`EXCEPTIONS entry ${id}: note is missing or empty`);
        }
    }

    const idCount = new Map();
    const keyCount = new Map();
    for (const f of flags) {
        if (!f || typeof f.id !== 'string' || typeof f.key !== 'string') {
            out.push('registry entry without string id and key');
            continue;
        }
        idCount.set(f.id, (idCount.get(f.id) || 0) + 1);
        keyCount.set(f.key, (keyCount.get(f.key) || 0) + 1);
    }
    for (const [id, n] of idCount) {
        if (n > 1) out.push(`duplicate id: ${id} (${n} entries)`);
    }
    for (const [key, n] of keyCount) {
        if (n > 1) out.push(`duplicate key: ${key} (${n} entries)`);
    }

    for (const f of flags) {
        if (!f || typeof f.id !== 'string') continue;
        if (f.defaultEnabled === true && !DEFAULT_ON_STAGES.has(f.stage) && !exempted.has(f.id)) {
            out.push(
                `default-on flag ${f.id} (${f.key}) has stage ${f.stage}; promote to stable or add an EXCEPTIONS entry`
            );
        }
    }

    for (const id of exempted) {
        if (!idCount.has(id)) out.push(`EXCEPTIONS entry ${id}: unknown flag id`);
    }

    const expected = new Map(providerKeys.map((k) => [_providerKeyOf(k), k]));
    const actual = new Set(
        flags.filter((f) => f && typeof f.key === 'string' && f.key.startsWith('PROVIDER_')).map((f) => f.key)
    );
    for (const [key, k] of expected) {
        if (!actual.has(key)) out.push(`provider flag missing for PROVIDER_KEYS entry "${k}" (expected ${key})`);
    }
    for (const key of actual) {
        if (!expected.has(key)) out.push(`provider flag ${key} is not in PROVIDER_KEYS (drift)`);
    }

    return out;
}

module.exports = {
    FEATURE_FLAGS,
    EXCEPTIONS,
    FEATURE_FLAGS_LOCAL_FILE,
    readLocalFile,
    resolve,
    resolveWithSource,
    resolveSpec,
    resolveSpecWithSource,
    checkInvariant,
};
