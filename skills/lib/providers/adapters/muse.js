/**
 * Muse (muse.ai) provider adapter config.
 *
 * DRAFT / BEST-EFFORT SELECTORS — live Muse DOM was NOT CDP-proven on this
 * branch. Prefer durable generics (textarea / contenteditable / role=textbox)
 * AFTER any Muse-specific guesses. Default posture remains draft-only: the
 * adapter exists so OneWeb + agentweb-setup can classify/open the Muse tab.
 * Do NOT claim live chat prove passed. Live CDP prove is out of scope until
 * Karl reopens social/browser work.
 *
 * Auth domains are path guesses (muse.ai/login, accounts.muse.ai) — no
 * credentials invented here.
 */

const { COMMON_DISMISS_PATTERNS } = require('../../providerFactory');
const { makeStillWorkingCheck } = require('../../stillWorking');

// Hoisted so stillGeneratingCheck judges the same container family the
// factory polls. Generics dominate — specific class guesses may be stale.
const RESPONSE_SELECTORS = [
    // Muse-specific guesses (may not match live DOM)
    '[class*="muse-message"]',
    '[class*="agent-message"]',
    '[class*="assistant-message"]',
    '[data-testid*="assistant" i]',
    '[data-testid*="message" i]',
    // Durable generics last
    '[class*="markdown"]',
    '[class*="message-content"]',
    '[class*="response"]',
    '[class*="answer"]',
    '[role="article"]',
];

module.exports = {
    key: 'muse',
    url: 'https://muse.ai/',
    navPostDelay: 4000, // agentic SPA — generous mount delay
    authDomains: ['muse.ai/login', 'accounts.muse.ai', 'muse.ai/signin'],
    quotaPatterns: [
        /rate\s*limit/i,
        /usage\s*limit/i,
        /reached\s*(?:your|the)?\s*limit/i,
        /try\s*again\s*later/i,
        /too\s*many\s*requests/i,
        /quota/i,
        /升级.*会员/i,
        /次数.*上限/i,
    ],
    dismissPatterns: [
        ...COMMON_DISMISS_PATTERNS,
        /welcome\s*to\s*muse/i,
        /get\s*started/i,
    ],
    editorSelectors: [
        // Muse-specific guesses first
        'textarea[placeholder*="Muse" i]',
        'textarea[placeholder*="Message" i]',
        'textarea[placeholder*="Ask" i]',
        '[data-testid*="composer" i]',
        '[data-testid*="chat-input" i]',
        '[class*="composer"] [contenteditable="true"]',
        '[class*="chat-input"]',
        // Durable generics
        'textarea',
        '[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"]',
        '[role="textbox"]',
    ],
    sendSelectors: [
        'button[aria-label*="Send" i]',
        'button[aria-label*="发送" i]',
        'button[type="submit"]',
        '[data-testid*="send" i]',
        'form button:has(svg)',
        '[class*="send"]',
    ],
    sendFallback: 'Enter',
    stopSelectors: [
        'button[aria-label*="Stop" i]',
        'button[aria-label*="停止" i]',
        'button[aria-label*="Cancel" i]',
        '[data-testid*="stop" i]',
    ],
    responseSelectors: RESPONSE_SELECTORS,
    responseSelectorTimeout: 60_000,
    stabilityWindow: 12_000,
    minResponseLength: 5,

    // Agentic product — tool/browse phases stall text like MiniMax/Kimi.
    // Hold cap bounds false positives. Live prove of these signals is TBD.
    stillGeneratingCheck: makeStillWorkingCheck({ responseSelectors: RESPONSE_SELECTORS }),
    stillGeneratingMaxHoldMs: 150_000,
};
