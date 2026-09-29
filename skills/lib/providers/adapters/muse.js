/**
 * Muse (muse.ai) provider adapter config.
 *
 * Live-probed 2026-09-29 on CDP :9227 (profile-5, logged-in Chat — Muse):
 *   - Editor: textarea[placeholder="Message"] / aria-label="Message"
 *   - Send: no stable Send button when empty — Enter fallback works
 *   - Side panels use class*=overlay (NOT modal dialogs) — must skipOverlay
 *   - Guest wall text "Log in or create an account / Mobile number" is a
 *     real auth gate; when Message textarea is visible the session is ready
 *   - NO <main> landmark on the Chat page. Assistant turns render as
 *     div.flex.flex-col.gap-2 wrapping span.sr-only.whitespace-pre-wrap
 *     whose textContent is "Assistant message: …". The visible answer is
 *     carried by that same bubble (parent.innerText includes the prefix).
 *     Prefer the bubble container; recover via textContent in
 *     postResponseHook when IN_PAGE_TEXT_WITH_MATH yields empty/chrome.
 *
 * Auth domains remain path guesses for redirect detection. No secrets here.
 */

const { COMMON_DISMISS_PATTERNS } = require('../../providerFactory');
const { makeStillWorkingCheck } = require('../../stillWorking');

// Prefer assistant bubbles over side-chat / dock overlays.
// Playwright :has-text is supported by the locator engine used in wait/extract.
const RESPONSE_SELECTORS = [
    // Best: assistant bubble container (720px-wide flex col with a11y label)
    'div.flex.flex-col.gap-2:has(span.sr-only.whitespace-pre-wrap):has-text("Assistant message")',
    // Direct a11y label (textContent has the full reply; innerText may be empty)
    'span.sr-only.whitespace-pre-wrap:has-text("Assistant message")',
    // Broader bubble match (still requires the a11y span)
    'div.flex.flex-col.gap-2:has(> span.sr-only.whitespace-pre-wrap)',
    // Role / testid guesses (harmless if absent)
    '[data-testid*="assistant" i]',
    '[aria-label*="Assistant message" i]',
    // Last-ditch generics — avoid bare [class*="overlay"] side docks
    '[class*="assistant"] [class*="prose"]',
    '[class*="assistant"] [class*="markdown"]',
    '[class*="message-content"]',
    '[role="article"]',
];

/**
 * Strip Muse a11y prefix and recover latest assistant reply when the factory
 * extract was empty or matched dock chrome.
 */
async function musePostResponseHook(page, text) {
    const strip = (s) => String(s || '')
        .replace(/^Assistant message:\s*/i, '')
        .trim();

    let t = strip(text);
    const looksEmpty = !t || t.length < 2;
    const looksChrome = /^(main\s*chat|side\s*chats|channels|whatsapp|unread\s*updates|show\s*in\s*library)\b/i.test(t)
        || /^(log in or create an account)\b/i.test(t);

    if ((looksEmpty || looksChrome) && page && typeof page.evaluate === 'function') {
        const recovered = await page.evaluate(() => {
            const spans = Array.from(
                document.querySelectorAll('span.sr-only.whitespace-pre-wrap')
            );
            for (let i = spans.length - 1; i >= 0; i--) {
                const raw = (spans[i].textContent || '').trim();
                if (/^Assistant message:/i.test(raw)
                    && raw.length > 'Assistant message:'.length + 1) {
                    return raw;
                }
            }
            // Visible bubble parents (no <main> on Muse Chat)
            const bubbles = Array.from(
                document.querySelectorAll('div.flex.flex-col.gap-2')
            ).filter((el) => {
                const label = el.querySelector('span.sr-only.whitespace-pre-wrap');
                if (!label) return false;
                const raw = (label.textContent || '').trim();
                if (!/^Assistant message:/i.test(raw)) return false;
                if (el.closest('[class*="overlay"]')) return false;
                const r = el.getBoundingClientRect();
                return r.width > 40 && r.height > 8;
            });
            if (bubbles.length) {
                const el = bubbles[bubbles.length - 1];
                return (el.innerText || el.textContent || '').trim();
            }
            return '';
        }).catch(() => '');
        if (recovered) t = strip(recovered);
    }

    return t;
}

module.exports = {
    key: 'muse',
    url: 'https://muse.ai/',
    navPostDelay: 2500,
    navWaitUntil: 'commit',
    navTimeout: 60000,
    authDomains: ['muse.ai/login', 'accounts.muse.ai', 'muse.ai/signin'],
    signedOutSelectors: [
        'input[placeholder*="Mobile number" i]',
        'input[placeholder*="email" i][placeholder*="Mobile" i]',
        'text=/Log in or create an account/i',
    ],
    quotaPatterns: [
        /rate\s*limit/i,
        /usage\s*limit/i,
        /reached\s*(?:your|the)?\s*limit/i,
        /try\s*again\s*later/i,
        /too\s*many\s*requests/i,
        /升级.*会员/i,
        /次数.*上限/i,
    ],
    dismissPatterns: [
        ...COMMON_DISMISS_PATTERNS,
        /welcome\s*to\s*muse/i,
        /get\s*started/i,
        /get\s*the\s*muse\s*app/i,
    ],
    skipOverlayPatterns: [
        /main\s*chat/i,
        /side\s*chats/i,
        /channels/i,
        /whatsapp/i,
        /unread\s*updates/i,
        /show\s*in\s*library/i,
        /restart\s*x\s*signup/i,
        /continue\s*account\s*setup/i,
    ],
    editorSelectors: [
        'textarea[placeholder="Message"]',
        'textarea[aria-label="Message"]',
        'textarea[placeholder*="Message" i]',
        'textarea[aria-label*="Message" i]',
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
    ],
    sendFallback: 'Enter',
    stopSelectors: [
        'button[aria-label*="Stop" i]',
        'button[aria-label*="停止" i]',
        'button[aria-label*="Cancel" i]',
        '[data-testid*="stop" i]',
    ],
    responseSelectors: RESPONSE_SELECTORS,
    responseSelectorTimeout: 90_000,
    stabilityWindow: 15_000,
    // Short prove replies like MUSE_OK (7 chars) must clear the gate.
    minResponseLength: 3,

    postResponseHook: musePostResponseHook,

    stillGeneratingCheck: makeStillWorkingCheck({ responseSelectors: RESPONSE_SELECTORS }),
    stillGeneratingMaxHoldMs: 180_000,
};

module.exports._musePostResponseHook = musePostResponseHook;
