'use strict';

/**
 * Machine-local registry of named, pinned provider threads
 * (~/.agentchat/threads.json).
 *
 * Why this exists: the standing Muse company thread used to live only in an
 * operator-side memory note and the AGENTCHAT_MUSE_URL env var, so a fresh
 * agent (grok/claude/codex/opencode) could not discover it without external
 * notes. The registry makes pinned threads a first-class, agent-agnostic
 * AgentChat feature: any agent can read the default pin and resume the
 * standing thread.
 *
 * File shape:
 *   { "version": 1, "threads": [ { name, provider, url, pinned_at, note? } ] }
 * A bare array of entries, or a single bare entry object, are also accepted
 * on load (tolerant reader).
 *
 * Default-pin rule: among entries for a provider, the most recently pinned
 * wins (pinned_at compared as ISO strings; file order breaks ties — later
 * entry wins).
 *
 * If the file is absent or unreadable, BUILTIN_THREADS is used as a
 * code-level fallback so the standing company Muse thread is always
 * discoverable, even on a fresh machine before install writes the seed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REGISTRY_VERSION = 1;

// Code-level fallback — used ONLY when the on-disk registry is absent or
// unreadable. Keep in sync with the install-time seed.
const BUILTIN_THREADS = [
    {
        name: 'company-main',
        provider: 'muse',
        url: 'https://muse.ai/thread/26242595-55a6-4263-9864-72e7dc71ab57',
        pinned_at: '2026-10-21',
        note: 'standing company Muse thread (orchestration infographic)',
    },
];

function _nonEmpty(v) {
    return (v != null && String(v).trim()) ? String(v).trim() : '';
}

function agentchatHome(env = process.env) {
    const fromEnv = _nonEmpty(env.AGENTCHAT_HOME);
    return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), '.agentchat');
}

function registryPath(env = process.env) {
    return path.join(agentchatHome(env), 'threads.json');
}

/**
 * Validate + normalize one entry. Returns null for anything malformed —
 * a corrupt entry must never crash a run; it is simply dropped on load.
 */
function normalizeEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const name = _nonEmpty(entry.name);
    const provider = _nonEmpty(entry.provider).toLowerCase();
    const url = _nonEmpty(entry.url);
    if (!name || !provider || !url) return null;
    const out = {
        name,
        provider,
        url,
        pinned_at: _nonEmpty(entry.pinned_at) || new Date().toISOString().slice(0, 10),
    };
    const note = _nonEmpty(entry.note);
    if (note) out.note = note;
    return out;
}

/**
 * Load the registry. Never throws: absent/unreadable/corrupt files all
 * degrade to the BUILTIN_THREADS fallback (flagged via source:'builtin').
 *
 * @returns {{version:number, threads:Array, source:string, error?:string}}
 */
function loadRegistry(env = process.env) {
    const p = registryPath(env);
    let raw;
    try {
        raw = fs.readFileSync(p, 'utf8');
    } catch (_) {
        return { version: REGISTRY_VERSION, threads: BUILTIN_THREADS.map(t => ({ ...t })), source: 'builtin' };
    }
    try {
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed)
            ? parsed
            : (Array.isArray(parsed.threads) ? parsed.threads : [parsed]);
        const threads = list.map(normalizeEntry).filter(Boolean);
        return { version: REGISTRY_VERSION, threads, source: p };
    } catch (e) {
        return {
            version: REGISTRY_VERSION,
            threads: BUILTIN_THREADS.map(t => ({ ...t })),
            source: 'builtin',
            error: String((e && e.message) || e),
        };
    }
}

/**
 * Upsert a pinned thread (keyed by provider+name) and persist atomically
 * (tmp file + rename — a crashed write must not leave a truncated registry).
 * Returns the normalized entry that was written.
 */
function pinThread(entry, env = process.env) {
    const clean = normalizeEntry(entry);
    if (!clean) throw new Error('pinThread requires non-empty name, provider, and url');
    const reg = loadRegistry(env);
    const threads = reg.threads.filter(
        t => !(t.provider === clean.provider && t.name === clean.name)
    );
    threads.push(clean);
    const p = registryPath(env);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: REGISTRY_VERSION, threads }, null, 2) + '\n');
    fs.renameSync(tmp, p);
    return clean;
}

/**
 * The default pinned thread for a provider: most recently pinned wins
 * (pinned_at desc; later file order breaks ties). Null when none pinned.
 */
function resolvePinnedThread(provider, env = process.env) {
    const key = _nonEmpty(provider).toLowerCase();
    if (!key) return null;
    const reg = loadRegistry(env);
    let best = null;
    for (const t of reg.threads) {
        if (t.provider !== key) continue;
        if (!best || String(t.pinned_at || '') >= String(best.pinned_at || '')) best = t;
    }
    return best;
}

function resolvePinnedThreadUrl(provider, env = process.env) {
    const t = resolvePinnedThread(provider, env);
    return t ? t.url : null;
}

module.exports = {
    REGISTRY_VERSION,
    BUILTIN_THREADS,
    agentchatHome,
    registryPath,
    loadRegistry,
    pinThread,
    resolvePinnedThread,
    resolvePinnedThreadUrl,
};
