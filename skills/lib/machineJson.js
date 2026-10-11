/**
 * Machine JSON for CLI ↔ SDK (AQ-008 / D11).
 *
 * Probe schema is owned by AgentChat-Muse doctor / PR #12 docs:
 *   {state, reason, seat, port, display, checked_at}
 *   state ∈ {ready, needs_human, blocked}
 *   reason is a sub-kind (null when ready). Never emit concatenated
 *   "needs_human:muse_login" — callers join state + reason themselves.
 *
 * OneWeb ask() emits a tagged stderr line that is a SUPerset of those
 * six keys plus SDK fields (provider_used, fallback_chain, model_used,
 * total_ms, exit, run_id). Stdout stays the raw AI response.
 *
 *   [oneweb] AGENTCHAT_STATE {json}
 *
 * The same state/reason/model_used/fallback_chain fields also ride on
 * the existing [receipt] AGENTCHAT_RUN line so either parse works.
 */
'use strict';

const { forkSeat, KNOWN_BOX_SEATS } = require('../../scripts/lib/seat-census.cjs');

const PUBLIC_KEYS = Object.freeze(['state', 'reason', 'seat', 'port', 'display', 'checked_at']);
const STATES = Object.freeze(['ready', 'needs_human', 'blocked']);
const STATE_PREFIX = '[oneweb] AGENTCHAT_STATE ';
const RECEIPT_PREFIX = '[receipt] AGENTCHAT_RUN ';

// Doctor probe reasons (PR #12 / AQ-007). Extra OneWeb sub-kinds below
// keep the same 3-state enum and must not invent a fourth state.
const PROBE_REASONS = Object.freeze(['seat', 'busy', 'muse_login', 'no_input', 'cdp_error']);

function expectedSeat(port) {
    const n = Number(port);
    if (n === 9222) return { seat: 'AgentChat', display: null };
    const known = KNOWN_BOX_SEATS.find(s => s.port === n);
    if (known) return { seat: known.seat, display: known.display || null };
    if (Number.isInteger(n) && n > 9222) {
        try {
            const s = forkSeat(n - 9222);
            return { seat: s.seat, display: s.display };
        } catch (_) { /* fall through */ }
    }
    return { seat: `cdp-${n}`, display: null };
}

function publicResult(result) {
    const state = STATES.includes(result && result.state) ? result.state : 'blocked';
    return {
        state,
        reason: state === 'ready' ? null : (result && result.reason != null ? result.reason : null),
        seat: result && result.seat != null ? result.seat : null,
        port: result && result.port != null ? result.port : null,
        display: result && result.display == null ? null : result.display,
        checked_at: result && result.checked_at != null ? result.checked_at : null,
    };
}

function parseLastTaggedJson(text, prefix) {
    const src = String(text || '');
    const index = src.lastIndexOf(prefix);
    if (index < 0) return null;
    const lineEnd = src.indexOf('\n', index);
    const payload = src.slice(index + prefix.length, lineEnd < 0 ? undefined : lineEnd).trim();
    try {
        const obj = JSON.parse(payload);
        return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
    } catch (_) {
        return null;
    }
}

function parseStateLine(text) {
    return parseLastTaggedJson(text, STATE_PREFIX);
}

function parseReceiptOrState(text) {
    return parseStateLine(text) || parseLastTaggedJson(text, RECEIPT_PREFIX);
}

function isMuseContext({ museOnly, providerUsed, providersTried, reasons } = {}) {
    if (museOnly) return true;
    const name = String(providerUsed || '').toLowerCase();
    if (name === 'muse') return true;
    const tried = Array.isArray(providersTried) ? providersTried : [];
    if (tried.length && tried.every(k => String(k).toLowerCase() === 'muse')) return true;
    const keys = Object.keys(reasons || {});
    if (keys.length && keys.every(k => String(k).toLowerCase() === 'muse')) return true;
    return false;
}

function flattenReasons(reasons) {
    if (!reasons || typeof reasons !== 'object') return [];
    return Object.entries(reasons).map(([key, v]) => {
        if (typeof v === 'string') return { key, reason: v, stage: '' };
        return {
            key,
            reason: String((v && v.reason) || ''),
            stage: String((v && v.stage) || (v && v.error_details && v.error_details.stage) || ''),
        };
    });
}

/**
 * Map a OneWeb ask() outcome onto the PR #12 probe state/reason pair.
 * Exit codes stay OneWeb's existing contract; state is independent.
 */
function classifyOneWebOutcome({
    exit = 0,
    reasons = null,
    providerUsed = null,
    providersTried = null,
    busy = false,
    museOnly = false,
} = {}) {
    const muse = isMuseContext({ museOnly, providerUsed, providersTried, reasons });
    const rows = flattenReasons(reasons);

    if (busy) return { state: 'blocked', reason: 'busy' };
    if (exit === 0) return { state: 'ready', reason: null };
    if (exit === 1) return { state: 'blocked', reason: 'seat' };
    if (exit === 2) {
        return { state: 'needs_human', reason: muse ? 'muse_login' : 'login' };
    }
    if (exit === 4) return { state: 'blocked', reason: 'cdp_error' };
    if (exit === 5) return { state: 'blocked', reason: 'quota' };
    if (exit === 10) return { state: 'blocked', reason: 'timeout' };
    if (exit === 64) return { state: 'blocked', reason: 'usage' };

    const joined = rows.map(r => `${r.reason}@${r.stage}`).join(' ');
    if (/editor_find|no_input|no editable/i.test(joined)) {
        return { state: 'blocked', reason: 'no_input' };
    }
    if (/browser_lost|cdp/i.test(joined)) {
        return { state: 'blocked', reason: 'cdp_error' };
    }
    if (rows.length && rows.every(r => /auth/i.test(r.reason))) {
        return { state: 'needs_human', reason: muse ? 'muse_login' : 'login' };
    }
    if (exit === 3) return { state: 'blocked', reason: 'safety' };
    return { state: 'blocked', reason: 'cdp_error' };
}

function buildSdkPayload(input = {}) {
    const probe = publicResult(input);
    const chain = Array.isArray(input.fallback_chain)
        ? input.fallback_chain
        : (Array.isArray(input.providers_tried) ? input.providers_tried : []);
    return {
        ...probe,
        provider_used: input.provider_used == null ? null : input.provider_used,
        fallback_chain: chain,
        model_used: input.model_used == null ? '' : input.model_used,
        total_ms: Number.isFinite(input.total_ms) ? input.total_ms : 0,
        exit: Number.isFinite(input.exit) ? input.exit : 0,
        run_id: input.run_id || null,
    };
}

function emitStateLine(payload, write) {
    try {
        const line = STATE_PREFIX + JSON.stringify(payload) + '\n';
        const out = write || ((s) => process.stderr.write(s));
        out(line);
        return line;
    } catch (_) {
        return null;
    }
}

module.exports = {
    PUBLIC_KEYS,
    STATES,
    STATE_PREFIX,
    RECEIPT_PREFIX,
    PROBE_REASONS,
    expectedSeat,
    publicResult,
    parseLastTaggedJson,
    parseStateLine,
    parseReceiptOrState,
    isMuseContext,
    classifyOneWebOutcome,
    buildSdkPayload,
    emitStateLine,
};
