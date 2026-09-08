/**
 * Grok (grok.com / xAI) provider adapter config.
 *
 * Key features (live-probed 2026-09-08):
 *   - Composer mode selector: Auto / Fast (page default) / Expert ("Thinks hard") /
 *     Heavy (paid tier, never selected) / Build. Trigger: button[aria-label="Model
 *     select"]; menu items are div[role="menuitemradio"] (Radix — real locator
 *     clicks only, el.click() inside evaluate never opens the menu).
 *   - Editor: div.tiptap.ProseMirror[contenteditable].
 *   - Thinking default ON: selects Expert unless AGENTCHAT_GROK_NO_THINK=1.
 *   - Web search: grok.com exposes NO search toggle — grounding is automatic
 *     (like Gemini). ensureGrokDeepSearchOn stays as a fail-soft hook in case
 *     xAI re-adds a DeepSearch chip; AGENTCHAT_GROK_NO_WEB_SEARCH=1 skips it.
 *   - Deep research opt-in: AGENTCHAT_GROK_DEEP_RESEARCH=1 or --deep-research.
 *     DeeperSearch/DeepResearch was NOT present on the probed free account —
 *     the hook logs 'missing' and continues; budget override still applies.
 */

const { COMMON_DISMISS_PATTERNS } = require('../../providerFactory');
const { isDeepResearchActive, DEEP_RESEARCH_TIMEOUT_MS } = require('../chain');

// Safe stderr logger — logs via terminal utility if available
let glog = () => {};
try {
    const { log: _tlog } = require('../../terminal');
    glog = (msg) => { try { _tlog('grok', msg); } catch (_) {} };
} catch (_) { /* logger unavailable — stay silent */ }

/**
 * Ensure Grok is in Expert mode (extended reasoning / "Thinks hard").
 * Skips Heavy (paid tier). Verifies by re-reading trigger text.
 */
async function ensureGrokExpertMode(page) {
    if (process.env.AGENTCHAT_GROK_NO_THINK === '1') {
        glog('Expert mode opt-out (AGENTCHAT_GROK_NO_THINK=1)');
        return 'skipped';
    }
    try {
        const trigger = page.locator('button[aria-label="Model select"]').first();
        // One round-trip: textContent auto-waits; null/absence → missing.
        const cur = await trigger.textContent({ timeout: 2000 }).catch(() => null);
        if (cur === null || cur === undefined) {
            glog('mode selector button not found');
            return 'missing';
        }
        if (/^Expert\b/i.test(cur.trim())) {
            glog('Expert mode already active');
            return 'already-on';
        }
        await trigger.click({ timeout: 3000 });
        // Expert item only — never Heavy (paid tier) and never Build.
        const item = page.locator('[role="menuitemradio"]')
            .filter({ hasText: /^Expert\b/i }).first();
        await item.waitFor({ state: 'visible', timeout: 2500 });
        await item.click({ timeout: 2500 });
        if (page.waitForTimeout) await page.waitForTimeout(400);
        const now = ((await trigger.textContent()) || '').trim();
        if (/^Expert\b/i.test(now)) {
            glog('Expert mode activated');
            return 'clicked';
        }
        glog('failed to verify Expert mode activation');
        return 'failed';
    } catch (e) {
        glog(`ensureGrokExpertMode error: ${e.message}`);
        return 'error';
    }
}

/**
 * Shared composer-toggle ensurer (DeepSearch chip, DeeperSearch/DeepResearch).
 * Clicks only when the control is provably OFF — strict state predicate climbs
 * ≤3 ancestors (aria-pressed/aria-checked/data-state/word-boundary classes).
 * Missing or ambiguous controls are logged and skipped, never blind-clicked.
 */
async function ensureGrokToggle(page, { label, includeSrc, excludeSrc, optOutEnv }) {
    if (optOutEnv && process.env[optOutEnv] === '1') {
        glog(`${label} opt-out (${optOutEnv}=1)`);
        return 'skipped';
    }
    try {
        const result = await page.evaluate(({ includeSrc, excludeSrc }) => {
            const include = new RegExp(includeSrc, 'i');
            const exclude = excludeSrc ? new RegExp(excludeSrc, 'i') : null;
            const ACTIVE_CLS = /(?:^|[\s_-])(?:active|checked|selected|enabled|on)(?:$|[\s_-])/i;
            const INACTIVE_CLS = /(?:^|[\s_-])(?:inactive|unchecked|unselected|disabled|off)(?:$|[\s_-])/i;
            const getState = (el) => {
                let probe = el;
                for (let d = 0; d < 4 && probe; d++, probe = probe.parentElement) {
                    if (!probe.getAttribute) continue;
                    const ap = probe.getAttribute('aria-pressed');
                    if (ap === 'true') return 'on';
                    if (ap === 'false') return 'off';
                    const ac = probe.getAttribute('aria-checked');
                    if (ac === 'true') return 'on';
                    if (ac === 'false') return 'off';
                    const ds = probe.dataset || {};
                    const state = (ds.state || probe.getAttribute('data-state') || '').toLowerCase();
                    if (state === 'checked' || state === 'on' || state === 'active') return 'on';
                    if (state === 'unchecked' || state === 'off' || state === 'inactive') return 'off';
                    if (ds.active === 'true' || probe.getAttribute('data-active') === 'true') return 'on';
                    if (ds.active === 'false' || probe.getAttribute('data-active') === 'false') return 'off';
                    const cls = typeof probe.className === 'string' ? probe.className : '';
                    if (ACTIVE_CLS.test(cls)) return 'on';
                    if (INACTIVE_CLS.test(cls)) return 'off';
                }
                return 'unknown';
            };
            const candidates = document.querySelectorAll(
                'button, [role="switch"], [role="button"], [role="checkbox"], [class*="chip"], [class*="toggle"], [class*="pill"]'
            );
            for (const el of candidates) {
                if (el.offsetParent === null && el.style && el.style.display === 'none') continue;
                const t = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
                if (!include.test(t) || (exclude && exclude.test(t)) || t.length > 50) continue;
                const state = getState(el);
                if (state === 'on') return { status: 'already-on' };
                if (state === 'off') {
                    el.click();
                    return { status: 'clicked' };
                }
                return { status: 'unknown' };
            }
            return { status: 'missing' };
        }, { includeSrc, excludeSrc: excludeSrc || '' });

        const status = result?.status || 'missing';
        if (status === 'already-on') glog(`${label} already active`);
        else if (status === 'clicked') glog(`${label} clicked ON`);
        else if (status === 'unknown') glog(`${label} control found but state ambiguous — skipped click`);
        else glog(`${label} control not found near composer`);
        if (status === 'clicked' && page.waitForTimeout) await page.waitForTimeout(500);
        return status;
    } catch (e) {
        glog(`${label} error: ${e.message}`);
        return 'error';
    }
}

const ensureGrokDeepSearchOn = (page) => ensureGrokToggle(page, {
    label: 'DeepSearch',
    includeSrc: /Deep\s*Search/.source,
    excludeSrc: /Deeper|Research/.source,
    optOutEnv: 'AGENTCHAT_GROK_NO_WEB_SEARCH',
});

const ensureGrokDeeperSearchOn = (page) => {
    if (!isDeepResearchActive('grok')) return Promise.resolve('skipped');
    return ensureGrokToggle(page, {
        label: 'DeeperSearch/DeepResearch',
        includeSrc: /Deeper\s*Search|Deep\s*Research/.source,
        excludeSrc: null,
    });
};

// Live 2026-09-08: composer is div.tiptap.ProseMirror[contenteditable] —
// prefer it over any stray/decoy textarea elsewhere on the page.
const GROK_EDITOR_SELECTORS = [
    '.tiptap[contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
    'form textarea',
    'textarea',
    '[role="textbox"]',
];

const adapter = {
    key: 'grok',
    url: 'https://grok.com/',
    authDomains: ['accounts.x.ai', 'x.ai/login', 'grok.com/login', 'x.com', 'twitter.com'],
    navPostDelay: 3000,
    providerTimeoutOverride: () => (isDeepResearchActive('grok') ? DEEP_RESEARCH_TIMEOUT_MS : undefined),
    quotaPatterns: [
        /rate\s*limit/i,
        /usage\s*limit/i,
        /reached\s*(?:your|the)?\s*limit/i,
        /try\s*again\s*later/i,
        /too\s*many\s*requests/i,
        // Narrow upgrade patterns tied to exhaustion (bare "Upgrade"/"SuperGrok" is a permanent upsell)
        /(?:reached|hit|exceeded).*(?:upgrade|supergrok)/i,
        /(?:limit|quota).*(?:upgrade|supergrok)/i,
        /次数.*已达上限/i,
        /使用量.*超限/i,
    ],
    dismissPatterns: [
        ...COMMON_DISMISS_PATTERNS,
        /welcome\s*back/i,
    ],
    editorSelectors: GROK_EDITOR_SELECTORS,
    sendSelectors: [
        'button[aria-label*="Send" i]',
        'button[aria-label*="发送" i]',
        'button[type="submit"]',
        'form button:has(svg)',
        '[data-testid*="send" i]',
    ],
    sendFallback: 'Enter',
    stopSelectors: [
        'button[aria-label*="Stop" i]',
        'button[aria-label*="停止" i]',
        '[data-testid*="stop" i]',
        'button[aria-label*="Cancel" i]',
    ],
    responseSelectors: [
        // Live-probed 2026-09-08: assistant answer renders inside
        // #last-reply-container → div.message-bubble[role="article"] →
        // .response-content-markdown. Anchor on those first so the user's own
        // prompt bubble is never extracted as the answer.
        '#last-reply-container .response-content-markdown',
        '.message-bubble[role="article"] .response-content-markdown',
        '.response-content-markdown',
        '[class*="message-bubble"][role="article"]',
        '[class*="markdown"]',
    ],
    stabilityWindow: 8000,
    minResponseLength: 10,

    preInputHook: async (page) => {
        try {
            if (page.locator) {
                const editorLoc = page.locator(GROK_EDITOR_SELECTORS.join(', ')).first();
                await editorLoc.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
            }
        } catch (_) {}

        // Step 1: Thinking default ON (Expert mode)
        try {
            await ensureGrokExpertMode(page);
        } catch (e) {
            glog(`ensureGrokExpertMode error: ${e.message}`);
        }

        // Step 2: deep research supersedes plain DeepSearch when active
        if (isDeepResearchActive('grok')) {
            try {
                const drRes = await ensureGrokDeeperSearchOn(page);
                if (drRes === 'clicked' || drRes === 'already-on') return;
            } catch (e) {
                glog(`ensureGrokDeeperSearchOn error: ${e.message}`);
            }
        }

        try {
            await ensureGrokDeepSearchOn(page);
        } catch (e) {
            glog(`ensureGrokDeepSearchOn error: ${e.message}`);
        }
    },
};

adapter._ensureGrokExpertMode = ensureGrokExpertMode;
adapter._ensureGrokDeepSearchOn = ensureGrokDeepSearchOn;
adapter._ensureGrokDeeperSearchOn = ensureGrokDeeperSearchOn;
adapter._isDeepResearchActive = () => isDeepResearchActive('grok');

module.exports = adapter;
