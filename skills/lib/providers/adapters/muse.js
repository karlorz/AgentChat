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
 *     whose textContent is "Assistant message: …". Prefer those bubbles;
 *     strip the a11y prefix in postResponseHook; recover via textContent
 *     when IN_PAGE_TEXT_WITH_MATH yields empty/chrome.
 *   - Reused Main chat tabs can silently drop Enter if focus is on a side
 *     dock: preInputHook clicks "Main chat"; customSend verifies a new
 *     "User message:" sr-only bubble appeared after Enter.
 *
 * Auth domains remain path guesses for redirect detection. No secrets here.
 */

const { COMMON_DISMISS_PATTERNS } = require('../../providerFactory');
const { makeStillWorkingCheck } = require('../../stillWorking');

let mlog = () => {};
try {
    const { log: _tlog } = require('../../terminal');
    mlog = (msg) => { try { _tlog('muse', msg); } catch (_) {} };
} catch (_) { /* stay silent */ }

const RESPONSE_SELECTORS = [
    // Best: assistant bubble container with a11y label
    'div.flex.flex-col.gap-2:has(span.sr-only.whitespace-pre-wrap):has-text("Assistant message")',
    // Direct a11y label (textContent has the full reply; innerText may be empty)
    'span.sr-only.whitespace-pre-wrap:has-text("Assistant message")',
    // Broader bubble match
    'div.flex.flex-col.gap-2:has(> span.sr-only.whitespace-pre-wrap)',
    '[data-testid*="assistant" i]',
    '[aria-label*="Assistant message" i]',
    '[class*="assistant"] [class*="prose"]',
    '[class*="assistant"] [class*="markdown"]',
    '[class*="message-content"]',
    '[role="article"]',
];

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

/** Ensure the Main chat nav row is selected before typing. */
async function musePreInputHook(page) {
    try {
        const clicked = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('div, button, a, [role="button"]'));
            const main = rows.find((el) => {
                const t = ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
                return /^Main chat$/i.test(t.replace(/\s+/g, ' '));
            });
            if (!main) return false;
            main.click();
            return true;
        });
        if (clicked) {
            mlog('preInput: focused Main chat nav row');
            await page.waitForTimeout(400);
        }
    } catch (_) { /* best-effort */ }
}

async function museCustomSend(page, editor) {
    const readEditor = async () => {
        try {
            return await editor.evaluate((el) => {
                const raw = (el.value !== undefined && el.tagName === 'TEXTAREA')
                    ? el.value : (el.innerText || el.textContent || '');
                return String(raw || '').replace(/\s+/g, ' ').trim();
            });
        } catch (_) { return ''; }
    };

    const lastUserText = async () => page.evaluate(() => {
        const msgs = Array.from(document.querySelectorAll('span.sr-only.whitespace-pre-wrap'))
            .map((s) => (s.textContent || '').trim())
            .filter((t) => /^User message:/i.test(t));
        return msgs.length ? msgs[msgs.length - 1] : '';
    }).catch(() => '');

    const asstCount = async () => page.evaluate(() =>
        Array.from(document.querySelectorAll('span.sr-only.whitespace-pre-wrap'))
            .filter((s) => /^Assistant message:/i.test((s.textContent || '').trim())).length
    ).catch(() => 0);

    const userEcho = async (needle) => {
        if (!needle || needle.length < 8) return false;
        const last = await lastUserText();
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const n = norm(needle).slice(0, 48);
        return n.length >= 8 && norm(last).includes(n);
    };

    let needle = await readEditor();
    if (!needle) throw new Error('Muse customSend: composer empty before send');

    const beforeAsst = await asstCount();

    const waitCommit = async (label, ms = 12000) => {
        const start = Date.now();
        while (Date.now() - start < ms) {
            const echo = await userEcho(needle);
            const cleared = !(await readEditor());
            const asstGrew = (await asstCount()) > beforeAsst;
            // Success: real User sr-only echo, OR (composer cleared AND a new
            // assistant bubble appeared — Muse sometimes collapses user text).
            if (echo || (cleared && asstGrew)) {
                mlog(`send: ${label} committed (echo=${echo} cleared=${cleared} asstGrew=${asstGrew})`);
                return true;
            }
            await page.waitForTimeout(400);
        }
        return false;
    };

    const sendBtn = page.locator('button[aria-label="Send"], button[aria-label*="Send" i]').last();
    if (await sendBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await sendBtn.click({ timeout: 3000 });
        if (await waitCommit('aria-label=Send', 15000)) return;
        mlog('send: Send clicked but no commit proof — re-fill and try Enter');
        if (!(await readEditor())) await museInput(page, editor, needle);
    }

    await editor.focus().catch(() => {});
    await page.keyboard.press('Enter');
    if (await waitCommit('Enter', 8000)) return;
    if (!(await readEditor())) await museInput(page, editor, needle);
    await editor.focus().catch(() => {});
    await page.keyboard.press('ControlOrMeta+Enter');
    if (await waitCommit('Ctrl/Meta+Enter', 8000)) return;

    throw new Error(
        `Muse send did not commit (needle=${JSON.stringify(needle.slice(0, 60))}, lastUser=${JSON.stringify((await lastUserText()).slice(0, 80))})`
    );
}

async function museInput(page, editor, prompt) {
    const want = String(prompt || '');
    await editor.click({ timeout: 3000 }).catch(() => {});
    await editor.fill('');
    try {
        await editor.fill(want);
    } catch (_) {
        await page.keyboard.type(want, { delay: 8 });
    }
    await page.waitForTimeout(200);
    const got = await editor.evaluate((el) => {
        const raw = (el.value !== undefined && el.tagName === 'TEXTAREA')
            ? el.value : (el.innerText || el.textContent || '');
        return String(raw || '');
    }).catch(() => '');
    if (got.replace(/\s+/g, ' ').includes(want.replace(/\s+/g, ' ').slice(0, 24))) {
        return true;
    }
    // Last resort: native value setter + InputEvent (React 17 onChange)
    const ok = await editor.evaluate((el, t) => {
        el.focus();
        const native = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
        ).set;
        native.call(el, t);
        el.dispatchEvent(new InputEvent('input', {
            bubbles: true, cancelable: true, data: t, inputType: 'insertText',
        }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return el.value === t;
    }, want).catch(() => false);
    return !!ok;
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
    minResponseLength: 3,

    input: museInput,
    preInputHook: musePreInputHook,
    customSend: museCustomSend,
    postResponseHook: musePostResponseHook,

    stillGeneratingCheck: makeStillWorkingCheck({ responseSelectors: RESPONSE_SELECTORS }),
    stillGeneratingMaxHoldMs: 180_000,
};

module.exports._musePostResponseHook = musePostResponseHook;
module.exports._museCustomSend = museCustomSend;
