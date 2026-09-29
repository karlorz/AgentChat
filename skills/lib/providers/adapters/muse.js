/**
 * Muse (muse.ai) provider adapter config.
 *
 * Live-probed 2026-09-29 on CDP :9227 (dedicated chrome-profile-muse-prove,
 * logged-in Chat — Muse):
 *   - Editor: textarea[placeholder="Message"] / aria-label="Message"
 *   - Send: aria-label=Send when filled; Enter fallback works
 *   - Side panels use class*=overlay (NOT modal dialogs) — must skipOverlay
 *   - Guest wall text "Log in or create an account / Mobile number" is a
 *     real auth gate; when Message textarea is visible the session is ready
 *   - Main chat: assistant turns as span.sr-only "Assistant message: …"
 *     inside div.flex.flex-col.gap-2. Prefer those; strip a11y prefix in
 *     postResponseHook.
 *   - Main chat is often agentic (history swallows literal proves). Prefer
 *     opening a fresh New side chat before send. Side chat uses [data-message-role=user|assistant] (sr-only often only
 *     "You:"). Prefer those selectors; keep Main sr-only path as fallback.
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
    // Side chat / modern Main: durable role attrs (no sr-only).
    '[data-message-role="assistant"]',
    '[data-message-side="agent"]',
    // Adapter-injected marker (evaluate-wait stamp fallback).
    '#agentchat-muse-extract',
    // Legacy Main chat a11y labels.
    'span.sr-only.whitespace-pre-wrap:has-text("Assistant message")',
    'div.flex.flex-col.gap-2:has(> span.sr-only.whitespace-pre-wrap)',
    '[data-testid*="assistant" i]',
    '[aria-label*="Assistant message" i]',
    '[class*="message-content"]',
    '[role="article"]',
];

async function musePostResponseHook(page, text) {
    const strip = (s) => String(s || '')
        .replace(/^Assistant message:\s*/i, '')
        .replace(/^Muse:\s*/i, '')
        .trim();

    let t = strip(text);
    const looksEmpty = !t || t.length < 2;
    const looksChrome = /^(main\s*chat|side\s*chats|channels|whatsapp|unread\s*updates|show\s*in\s*library)\b/i.test(t)
        || /^(log in or create an account)\b/i.test(t);

    if ((looksEmpty || looksChrome) && page && typeof page.evaluate === 'function') {
        const recovered = await page.evaluate(() => {
            const byRole = Array.from(document.querySelectorAll('[data-message-role="assistant"]'));
            if (byRole.length) {
                return (byRole[byRole.length - 1].innerText || '').trim();
            }
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
                if (el.closest('[class*="overlay"]')) return false;
                const r = el.getBoundingClientRect();
                if (!(r.width > 40 && r.height > 8)) return false;
                const label = el.querySelector('span.sr-only.whitespace-pre-wrap');
                if (label) {
                    const raw = (label.textContent || '').trim();
                    return /^Assistant message:/i.test(raw);
                }
                // Side-chat bubbles often lack sr-only — keep short visible replies.
                const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
                if (!txt || txt.length > 500) return false;
                if (/^(You:|Main chat|Side chats|Channels|Message)$/i.test(txt)) return false;
                return true;
            });
            if (bubbles.length) {
                const el = bubbles[bubbles.length - 1];
                const label = el.querySelector('span.sr-only.whitespace-pre-wrap');
                if (label) return (label.textContent || '').trim();
                return (el.innerText || el.textContent || '').trim();
            }
            // Side chat without sr-only: after the latest "You:" line, take the next short reply.
            const lines = (document.body.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean);
            for (let i = lines.length - 1; i >= 0; i--) {
                if (/^You:\s+/i.test(lines[i])) {
                    for (let j = i + 1; j < lines.length && j <= i + 6; j++) {
                        const r = lines[j];
                        if (/^You:/i.test(r)) break;
                        if (/^(Main chat|Side chats|Channels|Message|Send|Muse Connected)/i.test(r)) continue;
                        if (r && r.length <= 120) return r;
                    }
                    break;
                }
            }
            return '';
        }).catch(() => '');
        if (recovered) t = strip(recovered);
    }

    return t;
}

/** Prefer a fresh New side chat so Main's agentic history cannot swallow proves. */
async function musePreInputHook(page) {
    try {
        const opened = await page.evaluate(() => {
            const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
            const visible = (el) => {
                const r = el.getBoundingClientRect();
                return r.width > 2 && r.height > 2;
            };
            const clickMatch = (pred) => {
                for (const el of document.querySelectorAll(
                    'button, a, [role="button"], [role="menuitem"], div, span'
                )) {
                    if (!visible(el)) continue;
                    const aria = norm(el.getAttribute('aria-label'));
                    const text = norm(el.innerText || el.textContent);
                    const title = norm(el.getAttribute('title'));
                    if (pred(aria, text, title, el)) {
                        el.click();
                        return { aria, text: text.slice(0, 80) };
                    }
                }
                return null;
            };

            // 1) Direct New side chat control
            let hit = clickMatch((aria, text, title) =>
                /^(new\s+side\s+chat|new\s+chat)$/i.test(aria)
                || /^(new\s+side\s+chat|new\s+chat)$/i.test(text)
                || /^(new\s+side\s+chat|new\s+chat)$/i.test(title)
                || /new\s+side\s+chat/i.test(aria)
            );
            if (hit) return { step: 'direct', hit };

            // 2) Side chat options → New …
            hit = clickMatch((aria, text) =>
                /^side\s+chat\s+options$/i.test(aria)
                || /^side\s+chat\s+options$/i.test(text)
            );
            return hit ? { step: 'options', hit } : null;
        });

        if (opened && opened.step === 'options') {
            await page.waitForTimeout(500);
            const menuHit = await page.evaluate(() => {
                const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
                for (const el of document.querySelectorAll(
                    '[role="menuitem"], button, a, [role="option"], div, span'
                )) {
                    const r = el.getBoundingClientRect();
                    if (r.width < 2 || r.height < 2) continue;
                    const t = norm(
                        (el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '')
                    );
                    if (/new\s+(side\s+)?chat/i.test(t) && t.length < 60) {
                        el.click();
                        return t.slice(0, 80);
                    }
                }
                return null;
            });
            if (menuHit) {
                mlog(`preInput: opened New side chat via options (${menuHit})`);
                await page.waitForTimeout(800);
                return;
            }
        } else if (opened && opened.step === 'direct') {
            mlog(`preInput: opened New side chat (${opened.hit.aria || opened.hit.text})`);
            await page.waitForTimeout(800);
            return;
        }

        // 3) Fallback: focus Main chat so Enter is not swallowed by a side dock
        const clickedMain = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('div, button, a, [role="button"]'));
            const main = rows.find((el) => {
                const t = ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
                return /^Main chat$/i.test(t.replace(/\s+/g, ' '));
            });
            if (!main) return false;
            main.click();
            return true;
        });
        if (clickedMain) {
            mlog('preInput: side-chat open missed — focused Main chat nav row');
            await page.waitForTimeout(400);
        } else {
            mlog('preInput: no side-chat/Main control found');
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
        const roles = Array.from(document.querySelectorAll('[data-message-role="user"]'))
            .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean);
        if (roles.length) return roles[roles.length - 1];
        const sr = Array.from(document.querySelectorAll('span.sr-only.whitespace-pre-wrap'))
            .map((s) => (s.textContent || '').trim())
            .filter((t) => /^User message:/i.test(t));
        if (sr.length) return sr[sr.length - 1];
        // Side chat: visible "You: …" markers
        const you = Array.from(document.querySelectorAll('div, span, p'))
            .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
            .filter((t) => /^You:\s+/i.test(t) && t.length < 400);
        return you.length ? you[you.length - 1] : '';
    }).catch(() => '');

    const asstCount = async () => page.evaluate(() => {
        const byRole = document.querySelectorAll('[data-message-role="assistant"]').length;
        if (byRole > 0) return byRole;
        const sr = Array.from(document.querySelectorAll('span.sr-only.whitespace-pre-wrap'))
            .filter((s) => /^Assistant message:/i.test((s.textContent || '').trim())).length;
        if (sr > 0) return sr;
        // Side-chat proxy: count short visible flex bubbles that are not chrome/You
        return Array.from(document.querySelectorAll('div.flex.flex-col.gap-2'))
            .filter((el) => {
                if (el.closest('[class*="overlay"]')) return false;
                const r = el.getBoundingClientRect();
                if (!(r.width > 40 && r.height > 8)) return false;
                const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
                if (!txt || /^You:/i.test(txt)) return false;
                if (/^(Main chat|Side chats|Channels|Message)$/i.test(txt)) return false;
                return true;
            }).length;
    }).catch(() => 0);

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
            // Success: user echo, OR (composer cleared AND a new assistant/side bubble).
            // Side-chat empty thread: composer clear alone after 1.2s is enough.
            const clearOnly = cleared && (Date.now() - start > 1200);
            if (echo || (cleared && asstGrew) || clearOnly) {
                mlog(`send: ${label} committed (echo=${echo} cleared=${cleared} asstGrew=${asstGrew} clearOnly=${clearOnly && !echo && !asstGrew})`);
                return true;
            }
            await page.waitForTimeout(400);
        }
        return false;
    };

    const sendBtn = page.locator('button[aria-label="Send"], button[aria-label*="Send" i]').last();
    if (await sendBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await sendBtn.click({ timeout: 3000 });
        if (await waitCommit('aria-label=Send', 15000)) { await museWaitAssistantAfterSend(page, beforeAsst, needle); return; }
        mlog('send: Send clicked but no commit proof — re-fill and try Enter');
        if (!(await readEditor())) await museInput(page, editor, needle);
    }

    await editor.focus().catch(() => {});
    await page.keyboard.press('Enter');
    if (await waitCommit('Enter', 8000)) { await museWaitAssistantAfterSend(page, beforeAsst, needle); return; }
    if (!(await readEditor())) await museInput(page, editor, needle);
    await editor.focus().catch(() => {});
    await page.keyboard.press('ControlOrMeta+Enter');
    if (await waitCommit('Ctrl/Meta+Enter', 8000)) { await museWaitAssistantAfterSend(page, beforeAsst, needle); return; }


    throw new Error(
        `Muse send did not commit (needle=${JSON.stringify(needle.slice(0, 60))}, lastUser=${JSON.stringify((await lastUserText()).slice(0, 80))})`
    );
}

/** After commit, poll via page.evaluate for a new assistant bubble (survives CDP wedge better than long locator waits). */
async function museWaitAssistantAfterSend(page, beforeAsst, needle) {
    const start = Date.now();
    const ms = 45000;
    const stamp = async (text) => {
        const clean = String(text || '').replace(/^Assistant message:\s*/i, '').trim();
        if (!clean) return;
        await page.evaluate((reply) => {
            let m = document.getElementById('agentchat-muse-extract');
            if (!m) {
                m = document.createElement('div');
                m.id = 'agentchat-muse-extract';
                m.setAttribute('data-agentchat', 'muse-extract');
                m.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
                document.body.appendChild(m);
            }
            m.textContent = reply;
        }, clean).catch(() => {});
    };
    while (Date.now() - start < ms) {
        const snap = await page.evaluate(() => {
            const asst = Array.from(document.querySelectorAll('[data-message-role="assistant"]'));
            const last = asst.length ? (asst[asst.length - 1].innerText || '').replace(/\s+/g, ' ').trim() : '';
            const sr = Array.from(document.querySelectorAll('span.sr-only.whitespace-pre-wrap'))
                .map((s) => (s.textContent || '').trim())
                .filter((x) => /^Assistant message:/i.test(x));
            return { asstCount: asst.length, last, srCount: sr.length, lastSr: sr.length ? sr[sr.length - 1] : '' };
        }).catch(() => null);
        if (snap && snap.asstCount > beforeAsst && snap.last) {
            await stamp(snap.last);
            mlog(`send: assistant via data-message-role (n=${snap.asstCount} text=${JSON.stringify(snap.last.slice(0, 60))})`);
            return true;
        }
        if (snap && snap.srCount > beforeAsst && snap.lastSr) {
            await stamp(snap.lastSr);
            mlog(`send: assistant via sr-only (n=${snap.srCount})`);
            return true;
        }
        await page.waitForTimeout(400);
    }
    mlog('send: assistant wait timed out — factory extract will continue');
    return false;
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
    responseSelectorTimeout: 25_000,
    stabilityWindow: 6_000,
    minResponseLength: 3,

    input: museInput,
    preInputHook: musePreInputHook,
    customSend: museCustomSend,
    postResponseHook: musePostResponseHook,

    stillGeneratingCheck: makeStillWorkingCheck({ responseSelectors: RESPONSE_SELECTORS }),
    stillGeneratingMaxHoldMs: 60_000,
};

module.exports._musePostResponseHook = musePostResponseHook;
module.exports._museCustomSend = museCustomSend;
