/**
 * Qwen (通义千问) provider adapter config.
 *
 * Key differences from standard pipeline:
 *   - React/Tailwind SPA — needs 3s navPostDelay for mount
 *   - Buttons have Tailwind generic classes — no reliable send selectors
 *   - Stop button removed from DOM (detached) when done, not just hidden
 *   - postResponseHook strips model-name prefix (e.g. "Qwen3.7-Max\n")
 */

const { inputViaClipboard, inputViaSimulatedPaste, inputViaKeyboard, COMMON_CN_QUOTA_PATTERNS, COMMON_DISMISS_PATTERNS } = require('../../providerFactory');
const { makeStillWorkingCheck } = require('../../stillWorking');
const { isDeepResearchActive, DEEP_RESEARCH_TIMEOUT_MS } = require('../chain');

// Safe stderr logger — logs via terminal utility if available
let qlog = () => {};
try {
    const { log: _tlog } = require('../../terminal');
    qlog = (msg) => { try { _tlog('qwen', msg); } catch (_) {} };
} catch (_) { /* logger unavailable — stay silent */ }

/**
 * Wait-for-visibility helper. Playwright's locator.isVisible() is an IMMEDIATE
 * check — its {timeout} option is ignored — so it must never be used to wait for
 * menu items that animate in. Uses waitFor(state:'visible') when available,
 * otherwise polls isVisible (mock pages in unit tests).
 */
async function waitVisible(loc, ms) {
    if (!loc) return false;
    if (loc.waitFor) {
        try {
            await loc.waitFor({ state: 'visible', timeout: ms });
            return true;
        } catch (_) { return false; }
    }
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (await loc.isVisible().catch(() => false)) return true;
        await new Promise(r => setTimeout(r, 50));
    }
    return false;
}

/**
 * Ensure Qwen Thinking mode is on.
 * Free tier (qianwen.com) has no standalone 深度思考 toggle — 思考研究 bundles
 * deep research and is opt-in only. Generic lookup searches composer buttons
 * for /深度思考|思考/ (excluding 思考研究 context) so it auto-activates if added.
 * Opt-out: AGENTCHAT_QWEN_NO_THINK=1.
 */
async function ensureQwenThinkingOn(page) {
    if (process.env.AGENTCHAT_QWEN_NO_THINK === '1') {
        qlog('Thinking opt-out (AGENTCHAT_QWEN_NO_THINK=1)');
        return 'skipped';
    }
    try {
        if (!page) throw new Error('page is required');

        let result = null;
        if (typeof page.evaluate === 'function') {
            result = await page.evaluate(() => {
                const candidates = document.querySelectorAll(
                    'button, [role="switch"], [role="button"], [role="checkbox"], [class*="chip"], [class*="toggle"], [class*="pill"]'
                );
                for (const el of candidates) {
                    if (el.getAttribute('role') === 'menuitemcheckbox' || el.getAttribute('role') === 'menuitem') {
                        continue;
                    }
                    const t = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
                    if (/思考研究/.test(t)) continue;
                    if (!/(?:深度思考|思考)/.test(t)) continue;
                    if (t.length > 50) continue;

                    const ap = el.getAttribute('aria-pressed');
                    const ac = el.getAttribute('aria-checked');
                    const cls = typeof el.className === 'string' ? el.className : '';
                    const isOn = ap === 'true' || ac === 'true' ||
                        /(?:^|[\s_-])(?:active|checked|selected|enabled|on)(?:$|[\s_-])/i.test(cls);
                    if (isOn) return { status: 'already-on' };
                    if (typeof el.click === 'function') {
                        el.click();
                        return { status: 'clicked' };
                    }
                }
                return { status: 'missing' };
            });
        } else if (typeof page.locator === 'function') {
            const loc = page.locator('button, [role="switch"], [role="checkbox"]')
                .filter({ hasText: /深度思考|思考/ })
                .first();
            const visible = await waitVisible(loc, 1000);
            if (visible) {
                const txt = (await loc.textContent().catch(() => '')) || '';
                if (!/思考研究/.test(txt)) {
                    const ap = await loc.getAttribute('aria-pressed').catch(() => null);
                    const ac = await loc.getAttribute('aria-checked').catch(() => null);
                    if (ap === 'true' || ac === 'true') {
                        result = { status: 'already-on' };
                    } else {
                        await loc.click({ timeout: 2000 });
                        result = { status: 'clicked' };
                    }
                }
            }
        }

        const status = result?.status || 'missing';
        if (status === 'already-on') {
            qlog('Thinking already active');
            return 'already-on';
        }
        if (status === 'clicked') {
            qlog('Thinking clicked ON');
            if (page.waitForTimeout) await page.waitForTimeout(300);
            return 'clicked';
        }

        qlog('Thinking: no standalone 深度思考 toggle on free tier (思考研究 bundles deep research — opt-in only)');
        return 'missing';
    } catch (err) {
        qlog(`ensureQwenThinkingOn error: ${err.message}`);
        return 'error';
    }
}

/**
 * Ensure Qwen Web search is on.
 * Free tier (qianwen.com) has no 联网搜索 toggle — grounding is automatic.
 * Generic lookup searches composer buttons for /联网搜索|联网/ so it auto-activates if added.
 * Opt-out: AGENTCHAT_QWEN_NO_WEB_SEARCH=1.
 */
async function ensureQwenWebSearchOn(page) {
    if (process.env.AGENTCHAT_QWEN_NO_WEB_SEARCH === '1') {
        qlog('Web search opt-out (AGENTCHAT_QWEN_NO_WEB_SEARCH=1)');
        return 'skipped';
    }
    try {
        if (!page) throw new Error('page is required');

        let result = null;
        if (typeof page.evaluate === 'function') {
            result = await page.evaluate(() => {
                const candidates = document.querySelectorAll(
                    'button, [role="switch"], [role="button"], [role="checkbox"], [class*="chip"], [class*="toggle"], [class*="pill"]'
                );
                for (const el of candidates) {
                    const t = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
                    if (!/联网搜索|联网/.test(t)) continue;
                    if (t.length > 50) continue;

                    const ap = el.getAttribute('aria-pressed');
                    const ac = el.getAttribute('aria-checked');
                    const cls = typeof el.className === 'string' ? el.className : '';
                    const isOn = ap === 'true' || ac === 'true' ||
                        /(?:^|[\s_-])(?:active|checked|selected|enabled|on)(?:$|[\s_-])/i.test(cls);
                    if (isOn) return { status: 'already-on' };
                    if (typeof el.click === 'function') {
                        el.click();
                        return { status: 'clicked' };
                    }
                }
                return { status: 'missing' };
            });
        } else if (typeof page.locator === 'function') {
            const loc = page.locator('button, [role="switch"], [role="checkbox"]')
                .filter({ hasText: /联网搜索|联网/ })
                .first();
            const visible = await waitVisible(loc, 1000);
            if (visible) {
                const ap = await loc.getAttribute('aria-pressed').catch(() => null);
                const ac = await loc.getAttribute('aria-checked').catch(() => null);
                if (ap === 'true' || ac === 'true') {
                    result = { status: 'already-on' };
                } else {
                    await loc.click({ timeout: 2000 });
                    result = { status: 'clicked' };
                }
            }
        }

        const status = result?.status || 'missing';
        if (status === 'already-on') {
            qlog('Web search already active');
            return 'already-on';
        }
        if (status === 'clicked') {
            qlog('Web search clicked ON');
            if (page.waitForTimeout) await page.waitForTimeout(300);
            return 'clicked';
        }

        qlog('Web search: no 联网搜索 control on free tier (grounding is automatic)');
        return 'missing';
    } catch (err) {
        qlog(`ensureQwenWebSearchOn error: ${err.message}`);
        return 'error';
    }
}

/** Evaluate seam for mock environments that only supply page.evaluate (pattern: kimi.js). */
async function runQwenDeepResearchViaEvaluate(page) {
    const res = await page.evaluate(() => {
        function findPill() {
            const btns = Array.from(document.querySelectorAll('button'));
            return btns.find(b => {
                const label = b.getAttribute('aria-label') || '';
                const txt = b.textContent || '';
                return /快速|思考研究/.test(label) || /快速|思考研究/.test(txt);
            });
        }
        function findRow() {
            const rows = Array.from(document.querySelectorAll('div[role="menuitemcheckbox"]'));
            return rows.find(r => /思考研究/.test(r.textContent || ''));
        }

        const pill = findPill();
        if (!pill) return { status: 'missing' };

        let row = findRow();
        if (!row) {
            if (typeof pill.click === 'function') pill.click();
            row = findRow();
        }
        if (!row) return { status: 'missing' };

        if (row.getAttribute('aria-checked') === 'true') {
            return { status: 'already-on' };
        }

        if (typeof row.click === 'function') row.click();

        const pillLabel = pill.getAttribute('aria-label') || '';
        const pillText = pill.textContent || '';
        const nowChecked = row.getAttribute('aria-checked');
        if (/思考研究/.test(pillLabel) || /思考研究/.test(pillText) || nowChecked === 'true') {
            return { status: 'clicked' };
        }
        return { status: 'clicked' };
    });

    const status = res?.status || 'missing';
    if (status === 'already-on') {
        qlog('Deep Research (思考研究) already active');
        return 'already-on';
    }
    if (status === 'clicked') {
        qlog('Deep Research (思考研究) activated');
        if (page.waitForTimeout) await page.waitForTimeout(300);
        return 'clicked';
    }
    qlog('Deep Research (思考研究) menu row not found');
    return 'missing';
}

/**
 * Ensure Qwen Deep Research mode is on.
 * OPT-IN ONLY via AGENTCHAT_QWEN_DEEP_RESEARCH=1 or global AGENTCHAT_DEEP_RESEARCH=1 (--deep-research).
 * Opens mode pill (`button[aria-label="快速"], button[aria-label="思考研究"]`),
 * checks `div[role="menuitemcheckbox"]` for 思考研究:
 *   - aria-checked="true" -> 'already-on'
 *   - else click & verify -> 'clicked'
 *   - row absent -> 'missing'
 */
async function ensureQwenDeepResearchOn(page) {
    if (!isDeepResearchActive('qwen')) {
        return 'skipped';
    }
    try {
        if (!page) throw new Error('page is required');

        // Mock evaluate seam (pattern: kimi.js)
        if (typeof page.locator !== 'function' && typeof page.evaluate === 'function') {
            return await runQwenDeepResearchViaEvaluate(page);
        }

        const pill = page.locator('button[aria-label="快速"], button[aria-label="思考研究"], button[aria-label*="快速"], button[aria-label*="思考研究"]').first();
        const hasPill = await waitVisible(pill, 2000);
        if (!hasPill) {
            qlog('Deep Research mode pill button not found');
            return 'missing';
        }

        const expanded = await pill.getAttribute('aria-expanded').catch(() => null);
        if (expanded !== 'true') {
            await pill.click({ timeout: 2500 });
            if (page.waitForTimeout) await page.waitForTimeout(200);
        }

        const row = page.locator('div[role="menuitemcheckbox"]').filter({ hasText: /思考研究/ }).first();
        const hasRow = await waitVisible(row, 2000);
        if (!hasRow) {
            qlog('Deep Research (思考研究) menu row not found');
            return 'missing';
        }

        const checked = await row.getAttribute('aria-checked');
        if (checked === 'true') {
            qlog('Deep Research (思考研究) already active');
            return 'already-on';
        }

        await row.click({ timeout: 2500 });
        if (page.waitForTimeout) await page.waitForTimeout(300);

        // Verify-by-effect: pill label becomes 思考研究 or row aria-checked flips
        const pillLabel = (await pill.getAttribute('aria-label').catch(() => '')) || '';
        const pillText = (await pill.textContent().catch(() => '')) || '';
        const nowChecked = await row.getAttribute('aria-checked').catch(() => null);

        if (/思考研究/.test(pillLabel) || /思考研究/.test(pillText) || nowChecked === 'true') {
            qlog('Deep Research (思考研究) activated');
            return 'clicked';
        }

        qlog('Deep Research (思考研究) clicked');
        return 'clicked';
    } catch (err) {
        qlog(`ensureQwenDeepResearchOn error: ${err.message}`);
        return 'error';
    }
}

// Hoisted so the still-working probe judges the same container family the
// factory polls (see kimi.js v11 note).
const RESPONSE_SELECTORS = [
    '[class*="message-select-wrapper-answer"]',
    '[class*="chat-answers-card-wrap"]',
    '[class*="message-select-content-inner"]',
    '[class*="message-select-content"]',
    '.chat-round.last-message-item',
    // v10: generic tails — four of the five above share the
    // message-select naming family; a single rename kills them together.
    '[class*="answer"]',
    '[class*="markdown"]',
];

module.exports = {
    key: 'qwen',
    url: 'https://www.qianwen.com/?source=tongyigw',
    providerTimeoutOverride: () => isDeepResearchActive('qwen') ? DEEP_RESEARCH_TIMEOUT_MS : undefined,
    navPostDelay: 3000, // React-based SPA needs time to mount
    authDomains: ['qianwen.com/login', 'login.aliyun.com', 'signin.aliyun.com'],
    quotaPatterns: [...COMMON_CN_QUOTA_PATTERNS],
    dismissPatterns: [...COMMON_DISMISS_PATTERNS, /提示/i],
    editorSelectors: [
        '[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"]',
        'textarea',
        '[role="textbox"]',
        '[class*="editor"]',
    ],
    validateEditor: async (loc) => {
        return loc.evaluate(el => {
            if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                return !el.hasAttribute('readonly') && !el.hasAttribute('disabled');
            }
            return el.getAttribute('contenteditable') !== 'false'
                && !el.hasAttribute('readonly')
                && !el.hasAttribute('disabled');
        });
    },
    // Qwen's buttons have Tailwind generic classes — Enter is the only reliable send
    sendSelectors: [],
    sendFallback: 'Enter',

    // ── Pre-input hook: wait for React editor to be ready ──
    // v22 FIX: qwen is a React/Tailwind SPA whose contenteditable editor may
    // lazy-mount (only when the input area scrolls into view). Without this
    // hook the factory's findEditableElement can silently match a hidden
    // fallback <textarea>, causing error@input on the first fill() attempt.
    preInputHook: async (page, C) => {
        try {
            // Primary: wait for the visible contenteditable editor
            await page.locator('[contenteditable="true"][role="textbox"]').first()
                .waitFor({ state: 'visible', timeout: 8000 });
        } catch (_) {
            // Fallback: extra settle time for slow SPA hydration
            await page.waitForTimeout(3000);
        }

        // Mode steps: each wrapped in fail-soft try/catch
        try {
            await ensureQwenThinkingOn(page);
        } catch (e) {
            qlog(`ensureQwenThinkingOn error: ${e.message}`);
        }

        try {
            await ensureQwenWebSearchOn(page);
        } catch (e) {
            qlog(`ensureQwenWebSearchOn error: ${e.message}`);
        }

        try {
            await ensureQwenDeepResearchOn(page);
        } catch (e) {
            qlog(`ensureQwenDeepResearchOn error: ${e.message}`);
        }
    },

    // ── Qwen-specific input: keyboard-first with explicit focus ──
    // v22 FIX: qwen's React editor does NOT handle ClipboardEvent('paste')
    // with DataTransfer (unlike chatgpt's ProseMirror). The simulated paste
    // clears the DOM then dispatches a paste event that qwen ignores, leaving
    // the editor empty. Subsequent keyboard.insertText dispatches to the
    // page-level focused element, but the React re-render after the DOM clear
    // often resets focus to document.body → text goes nowhere → empty editor
    // → composer mismatch → error@input.
    //
    // Strategy: keyboard-first (CDP Input.insertText is the most reliable
    // path for React editors that don't use ProseMirror), with explicit
    // re-focus before each method. Paste methods are fallback only.
    input: async (page, editor, prompt) => {
        // Ensure editor is focused — React may have reset focus after factory clear
        await editor.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(200);

        // Tier 1: keyboard.insertText chunked — CDP Input.insertText dispatches
        // real keydown/keypress/input/keyup events that React MUST handle.
        // Chunk at 150 chars with 40ms yield to let React re-render.
        await inputViaKeyboard(page, editor, prompt, { chunkSize: 150, yieldMs: 40 });

        // Tier 2: simulated ClipboardEvent if keyboard somehow failed
        const len = await editor.evaluate(el =>
            (el.innerText || el.textContent || '').length
        ).catch(() => 0);
        if (len < prompt.length * 0.8) {
            await editor.focus().catch(() => {});
            await inputViaSimulatedPaste(page, editor, prompt);
        }

        // Tier 3 (LAST RESORT): system clipboard — racy under concurrency
        const len2 = await editor.evaluate(el =>
            (el.innerText || el.textContent || '').length
        ).catch(() => 0);
        if (len2 < prompt.length * 0.8) {
            await editor.focus().catch(() => {});
            await inputViaClipboard(page, editor, prompt);
        }

        // Trigger React onChange via InputEvent to activate send pathway
        await editor.evaluate(node => {
            node.dispatchEvent(new InputEvent('input', {
                bubbles: true, composed: true,
                inputType: 'insertText', data: ' ',
            }));
        }).catch(() => {});
        await page.waitForTimeout(400);

        return true;
    },
    stopWaitMode: 'detached', // Qwen removes stop button from DOM when done
    stopSelectors: ['[class*="stop"]', '[class*="pause-generat"]'],
    responseSelectors: RESPONSE_SELECTORS,
    responseSelectorTimeout: 60_000,
    stabilityWindow: 8_000,
    minResponseLength: 5,

    // v11: phase-3 defense for 深度搜索 rounds. Phase-1 handles the detached
    // stop button, but if the stop SELECTOR drifts (or the button re-appears
    // between rounds after phase 1 already passed), the 8s window is as
    // vulnerable as Kimi's was. Bounded by the hold cap.
    stillGeneratingCheck: makeStillWorkingCheck({ responseSelectors: RESPONSE_SELECTORS }),
    stillGeneratingMaxHoldMs: 120_000,
    postResponseHook: async (_page, text) =>
        text.replace(/^Qwen[\d.]+-(?:Max|Plus|Turbo|Flash)\s*\n?\s*/i, '').trim(),
};

module.exports._ensureQwenThinkingOn = ensureQwenThinkingOn;
module.exports._ensureQwenWebSearchOn = ensureQwenWebSearchOn;
module.exports._ensureQwenDeepResearchOn = ensureQwenDeepResearchOn;
module.exports._isDeepResearchActive = () => isDeepResearchActive('qwen');

