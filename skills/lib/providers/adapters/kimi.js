/**
 * Kimi (月之暗面 Moonshot) provider adapter config.
 *
 * Key differences from standard pipeline:
 *   - preInputHook clicks "新建会话" / "New Chat" to start a fresh conversation,
 *     then ensures mode (Instant default) and Thinking effort (High default),
 *     or enters Deep Research mode if AGENTCHAT_KIMI_DEEP_RESEARCH=1
 *   - customSend handles Kimi's .send-button-container with disabled class detection
 *   - navPostDelay=4s for React SPA mount
 *   - postResponseHook rejects truncated opening lines (e.g. "我来从...")
 *   - v11: stillGeneratingCheck = shared multi-signal detector (stillWorking.js)
 *     covering the full 联网搜索 phase vocabulary (搜索→获取网页→阅读→整理),
 *     stop-control + spinner DOM signals, bounded by stillGeneratingMaxHoldMs
 *   - v21: preInputHook Step 0 — dismisses sidebar .mask overlay before
 *     clearEditor()/click(), preventing the 30s Playwright timeout from
 *     "subtree intercepts pointer events". Two-layer defense: click mask
 *     (natural UX), then force display:none as fallback.
 *   - v35: re-map to new UI (2026-09-08): mode dropdown Instant/K3/K3 Swarm,
 *     Thinking effort High/Standard, sidebar Deep Research mode, providerTimeoutOverride.
 */

const { COMMON_DISMISS_PATTERNS } = require('../../providerFactory');
const { makeStillWorkingCheck } = require('../../stillWorking');
const { isDeepResearchActive, DEEP_RESEARCH_TIMEOUT_MS } = require('../chain');

// v20: safe stderr logger — replaces the try{require('../../terminal')}catch
// boilerplate that had been copy-pasted at every log site in this adapter.
let klog = () => {};
try {
    const { log: _tlog } = require('../../terminal');
    klog = (msg) => { try { _tlog('kimi', msg); } catch (_) {} };
} catch (_) { /* logger unavailable — stay silent */ }

// ── v34: answer/toolcall container selectors (single source of truth) ──────
// Kimi renders thinking traces, search status, tool-call steps (class
// *toolcall*) and the final answer as SIBLING blocks inside the segment.
// These two classes drive BOTH the adapter's responseSelectors (extract the
// answer-only container) and the shared probe's S3d tool-phase hold (while
// toolcall blocks are live and the answer container is still empty,
// generation is not done).
const KIMI_ANSWER_SEL =
    '[class*="markdown-container"]:not([class*="toolcall"]):not([class*="tool-call"])';
const KIMI_TOOLCALL_SEL = '[class*="markdown-container"][class*="toolcall"]';

// ── v34: post-answer footer sanitizer ───────────────────────────────────────
// Defensive text pass: the structural fix (answer-only container) is
// primary; this only removes discrete post-answer footer lines, never the
// answer text itself.
const KIMI_UPGRADE_NOTICE_RE = /High demand\..*$/m;
const KIMI_REFERENCE_RE = /^\s*(?:Reference|參考資料|参考来源)\s*$/m;

/** Strip Kimi's post-answer upgrade/reference footer noise from a response. */
function cleanKimiMetaText(text) {
    if (!text) return '';
    return String(text)
        // Post-answer upgrade/upsell notice ("High demand. Switched to …").
        .replace(KIMI_UPGRADE_NOTICE_RE, '')
        // "Reference" footer heading (source chips follow it on later lines).
        .replace(KIMI_REFERENCE_RE, '')
        .split('\n').map(s => s.trim()).filter(Boolean).join('\n')
        .trim();
}

// ── v35: Mode selection and thinking effort for new Kimi UI (2026-09-08) ─────
// The composer bottom-right contains a mode dropdown trigger whose visible text
// shows e.g. "Instant High". Menu items include:
//   - "Instant" — "Fast chat, quick replies"
//   - "K3" — "Chat & Agent, flagship all-rounder" (selecting opens a NEW chat)
//   - "K3 Swarm" — "Massive search, batch processing, and more in one go" (opens a NEW chat)
//   - "Thinking effort" submenu → "High" / "Standard"
// Note: K3/K3 Swarm open a new chat, so mode selection must run AFTER the
// new-chat click but BEFORE typing.
// The old 深度思考 toggle and 快速模式 chips no longer exist (retired).
// AGENTCHAT_KIMI_KEEP_DEEPTHINK is obsolete and removed in v35.

/** Selectors for candidate menu items inside the opened mode dropdown. */
const KIMI_MENU_ITEM_SELECTORS = [
    '[role="menuitem"]',
    '[role="option"]',
    '[class*="dropdown-item"]',
    '[class*="menu-item"]',
    '[class*="menuItem"]',
    '[class*="item"]',
    'button',
    'div[tabindex]',
    'li',
];

/**
 * Ensure Kimi's mode dropdown is on the target mode.
 * Target: 'instant' (default) | 'k3' | 'k3-swarm'.
 * Override: AGENTCHAT_KIMI_MODE=k3|k3-swarm|instant (case-insensitive).
 *
 * @param {import('playwright-core').Page} page
 * @returns {Promise<boolean>} true if target mode is active or successfully activated
 */
async function ensureKimiMode(page) {
    try {
        const rawEnv = (process.env.AGENTCHAT_KIMI_MODE || '').trim().toLowerCase();
        let targetKey = 'instant';
        if (rawEnv === 'k3-swarm' || rawEnv === 'swarm' || rawEnv === 'k3swarm') {
            targetKey = 'k3-swarm';
        } else if (rawEnv === 'k3') {
            targetKey = 'k3';
        }

        // v35 fix: Playwright evaluate takes ONE argument — wrap in an object.
        const result = await page.evaluate(({ target, itemSels }) => {
            function isVisible(el) {
                if (!el) return false;
                if (el.offsetParent !== null) return true;
                if (el.style && el.style.display === 'none') return false;
                if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
                if (typeof el.getBoundingClientRect === 'function') {
                    const r = el.getBoundingClientRect();
                    if (r && (r.width > 0 || r.height > 0)) return true;
                }
                return !el.style || el.style.display !== 'none';
            }

            function matchesTarget(text, tgt) {
                const t = String(text || '').trim();
                if (tgt === 'k3-swarm') return /K3\s*Swarm/i.test(t);
                if (tgt === 'k3') return /^K3\b/i.test(t) && !/Swarm/i.test(t);
                return /^Instant\b/i.test(t) || /快速/.test(t);
            }

            function findTrigger() {
                const knownTriggers = [
                    ...document.querySelectorAll(
                        '[class*="mode-select"], [class*="ModeSelect"], [class*="mode-dropdown"], [class*="model-select"]'
                    )
                ];
                for (const el of knownTriggers) {
                    if (isVisible(el)) return el;
                }
                // Mode trigger button displays mode name e.g. "Instant", "K3", "K3 Swarm"
                const buttons = [
                    ...document.querySelectorAll('button, [role="button"], [class*="trigger"]')
                ];
                for (const b of buttons) {
                    if (!isVisible(b)) continue;
                    const t = (b.textContent || '').trim();
                    if (t.length > 0 && t.length < 40 && (/^Instant\b/i.test(t) || /^K3\b/i.test(t) || /快速/.test(t))) {
                        return b;
                    }
                }
                return null;
            }

            const trigger = findTrigger();
            if (!trigger) return { status: 'no_trigger' };

            const currentText = (trigger.textContent || '').trim();
            if (matchesTarget(currentText, target)) {
                return { status: 'already', text: currentText };
            }

            // Click trigger to open dropdown
            trigger.click();

            // Find matching menu item
            let targetItem = null;
            const allItems = [...document.querySelectorAll(itemSels.join(', '))];
            for (const item of allItems) {
                if (!isVisible(item)) continue;
                const t = (item.textContent || '').trim();
                if (t.length < 1 || t.length > 80) continue;
                if (matchesTarget(t, target)) {
                    targetItem = item;
                    break;
                }
            }

            if (!targetItem) {
                // Fallback: look through all visible clickable elements
                const fallbacks = [...document.querySelectorAll('div, span, li, a, button')];
                for (const el of fallbacks) {
                    if (!isVisible(el)) continue;
                    const t = (el.textContent || '').trim();
                    if (t.length >= 1 && t.length <= 80 && matchesTarget(t, target)) {
                        targetItem = el;
                        break;
                    }
                }
            }

            if (!targetItem) return { status: 'no_item', currentText };

            targetItem.click();

            // Re-read trigger to confirm
            const confirmedTrigger = findTrigger();
            const confirmedText = confirmedTrigger ? (confirmedTrigger.textContent || '').trim() : '';
            const ok = matchesTarget(confirmedText, target);
            return { status: ok ? 'ok' : 'verify_failed', text: confirmedText };
        }, { target: targetKey, itemSels: KIMI_MENU_ITEM_SELECTORS });

        if (result.status === 'already') {
            klog(`Kimi mode already on target (${targetKey}): "${result.text}"`);
            return true;
        }
        if (result.status === 'ok') {
            klog(`Kimi mode switched to ${targetKey}: "${result.text}"`);
            if (page.waitForTimeout) await page.waitForTimeout(500);
            return true;
        }
        if (result.status === 'no_trigger') {
            klog('⚠ Kimi mode trigger not found — using page default');
            return false;
        }
        if (result.status === 'no_item') {
            klog(`⚠ Kimi mode menu item for ${targetKey} not found — using page default`);
            return false;
        }
        klog(`⚠ Kimi mode verification failed (trigger showed "${result.text}") — using page default`);
        return false;
    } catch (e) {
        klog(`ensureKimiMode error: ${e.message} — using page default`);
        return false;
    }
}

/**
 * Ensure Kimi's Thinking effort is set to High (default) or Standard (opt-out).
 * Env override: AGENTCHAT_KIMI_NO_THINK=1 → Standard.
 *
 * Strategy:
 *   1. Open the mode dropdown (or read existing state).
 *   2. Find and open the "Thinking effort" submenu (click or hover).
 *   3. Click the target effort item (/^High$/i or /^Standard$/i).
 *   4. Verify effect.
 *
 * @param {import('playwright-core').Page} page
 * @returns {Promise<boolean>} true if thinking effort is active or set
 */
async function ensureKimiThinkingEffort(page) {
    try {
        const wantStandard = process.env.AGENTCHAT_KIMI_NO_THINK === '1';
        const targetEffort = wantStandard ? 'standard' : 'high';

        // v35 fix: Playwright evaluate takes ONE argument — wrap in an object.
        const result = await page.evaluate(({ target, itemSels }) => {
            function isVisible(el) {
                if (!el) return false;
                if (el.offsetParent !== null) return true;
                if (el.style && el.style.display === 'none') return false;
                if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
                if (typeof el.getBoundingClientRect === 'function') {
                    const r = el.getBoundingClientRect();
                    if (r && (r.width > 0 || r.height > 0)) return true;
                }
                return !el.style || el.style.display !== 'none';
            }

            function findTrigger() {
                const known = [
                    ...document.querySelectorAll(
                        '[class*="mode-select"], [class*="ModeSelect"], [class*="mode-dropdown"], [class*="model-select"]'
                    )
                ];
                for (const el of known) {
                    if (isVisible(el)) return el;
                }
                const buttons = [
                    ...document.querySelectorAll('button, [role="button"], [class*="trigger"]')
                ];
                for (const b of buttons) {
                    if (!isVisible(b)) continue;
                    const t = (b.textContent || '').trim();
                    if (t.length > 0 && t.length < 40 && (/^Instant\b/i.test(t) || /^K3\b/i.test(t) || /快速/.test(t))) {
                        return b;
                    }
                }
                return null;
            }

            const trigger = findTrigger();
            if (!trigger) return { status: 'no_trigger' };

            const trigText = (trigger.textContent || '').trim();
            // Trigger often includes effort, e.g. "Instant High"
            if (target === 'high' && /\bHigh\b/i.test(trigText)) {
                return { status: 'already', text: trigText };
            }
            if (target === 'standard' && /\bStandard\b/i.test(trigText)) {
                return { status: 'already', text: trigText };
            }

            // Click trigger to open menu
            trigger.click();

            // Find "Thinking effort" submenu entry
            const menuItems = [...document.querySelectorAll(itemSels.join(', '))];
            let effortMenu = null;
            for (const it of menuItems) {
                if (!isVisible(it)) continue;
                const t = (it.textContent || '').trim();
                if (/Thinking\s*effort|思考深度|推理深度/i.test(t)) {
                    effortMenu = it;
                    break;
                }
            }

            if (!effortMenu) {
                // Check all elements for Thinking effort
                const all = [...document.querySelectorAll('div, span, button, li')];
                for (const el of all) {
                    if (!isVisible(el)) continue;
                    const t = (el.textContent || '').trim();
                    if (/Thinking\s*effort|思考深度|推理深度/i.test(t) && t.length < 40) {
                        effortMenu = el;
                        break;
                    }
                }
            }

            if (!effortMenu) return { status: 'no_submenu' };

            // Open submenu: try click first, mouseenter as supplement
            effortMenu.click();
            try {
                effortMenu.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
            } catch (_) {}

            // Find target effort item: /^High$/i or /^Standard$/i
            const targetRe = target === 'high' ? /^High$/i : /^Standard$/i;
            let effortItem = null;
            const subItems = [...document.querySelectorAll(itemSels.join(', '))];
            for (const it of subItems) {
                if (!isVisible(it)) continue;
                const t = (it.textContent || '').trim();
                if (targetRe.test(t)) {
                    effortItem = it;
                    break;
                }
            }

            if (!effortItem) {
                const all = [...document.querySelectorAll('div, span, button, li')];
                for (const el of all) {
                    if (!isVisible(el)) continue;
                    const t = (el.textContent || '').trim();
                    if (targetRe.test(t)) {
                        effortItem = el;
                        break;
                    }
                }
            }

            if (!effortItem) return { status: 'no_effort_item' };

            effortItem.click();

            // Check if trigger or item indicates target
            const postTrig = findTrigger();
            const postText = postTrig ? (postTrig.textContent || '').trim() : '';
            return { status: 'ok', text: postText };
        }, { target: targetEffort, itemSels: KIMI_MENU_ITEM_SELECTORS });

        if (result.status === 'already') {
            klog(`Kimi thinking effort already on ${targetEffort}: "${result.text}"`);
            return true;
        }
        if (result.status === 'ok') {
            klog(`Kimi thinking effort set to ${targetEffort}: "${result.text}"`);
            if (page.waitForTimeout) await page.waitForTimeout(500);
            return true;
        }
        if (result.status === 'no_trigger') {
            klog('⚠ Kimi mode trigger not found for thinking effort — using page default');
            return false;
        }
        if (result.status === 'no_submenu') {
            klog('⚠ Kimi "Thinking effort" submenu not found — using page default');
            return false;
        }
        if (result.status === 'no_effort_item') {
            klog(`⚠ Kimi effort item "${targetEffort}" not found — using page default`);
            return false;
        }
        return false;
    } catch (e) {
        klog(`ensureKimiThinkingEffort error: ${e.message} — using page default`);
        return false;
    }
}

// Hoisted so responseSelectors and stillGeneratingCheck are guaranteed to
// judge the SAME container family. The old check hardcoded selector [0]
// ('[class*="chat-content-item-assistant"]') and silently read the wrong
// element — or nothing — whenever the factory had matched a fallback
// selector, disabling the check exactly when the DOM had drifted.
const RESPONSE_SELECTORS = [
    // v34: prefer the answer-only container — Kimi renders thinking traces,
    // tool-call steps (class *toolcall*), search status and the final answer
    // as separate blocks inside the segment. Only the REAL answer container
    // is wanted: extracting the whole segment (or a tool-call step) polluted
    // the response with "Think…", "Search <q> N results" and the upgrade
    // notice.
    `[class*="segment-assistant"] ${KIMI_ANSWER_SEL}`,
    KIMI_ANSWER_SEL,
    '[class*="chat-content-item-assistant"]',
    '[class*="segment-content"]',
    '[class*="chat-content-list"] [class*="assistant"]',
    // v34: last-resort fallback for the agentic tool phase — when the tool
    // steps finish but the final answer never renders in its own container,
    // the accumulated tool-call output is the best content available.
    `[class*="segment-assistant"] ${KIMI_TOOLCALL_SEL}`,
    KIMI_TOOLCALL_SEL,
    // v10: all three above anchor on the chat-content/segment naming
    // family — one rename kills them together. Generic tails are only
    // reached when the specific ones fail (budget-clamped upstream).
    '[class*="assistant"]',
    '[class*="markdown"]',
];

module.exports = {
    key: 'kimi',
    url: 'https://www.kimi.com/',
    navPostDelay: 4000, // React SPA render time
    authDomains: ['kimi.moonshot.cn/login', 'kimi.com/login', 'moonshot.cn/login'],
    // v35: Deep research runs 5-30 min. The 180s default per-provider budget
    // SIGKILLs the call (the same incident that motivated the old deep-think-off logic).
    // Raised to the shared DR budget (30 min) when deep research is opted in.
    providerTimeoutOverride: () => (isDeepResearchActive('kimi') ? DEEP_RESEARCH_TIMEOUT_MS : undefined),

    quotaPatterns: [
        /高峰.*算力.*不足/i,
        /Kimi.*(?:累了|休息)/i,
        /聊的人太多了/i,
        // BUGFIX: bare /前往升级/i matched the permanent "Upgrade" CTA
        // button/text visible on EVERY Kimi page (sidebar upsell banner),
        // falsely marking a perfectly available provider as quota-exhausted.
        // Only treat it as quota when tied to a usage-exhausted context
        // (same principle as Gemini adapter's narrow quota patterns — any
        // bare "Upgrade" link would false-positive on every page visit).
        /(?:额度|次数|用完|用尽|不够|上限).{0,30}前往升级/i,
        /额度.*(?:已|用).*(?:完|尽|满)/i,
    ],
    dismissPatterns: [...COMMON_DISMISS_PATTERNS, /版本.*更新/i],

    // ── Start fresh conversation + ensure fast mode ──
    preInputHook: async (page) => {
        // Step 0: Dismiss sidebar mask overlay.
        // Kimi's sidebar in is-mobile-expanded state renders a <div class="mask">
        // translucent overlay on top of the main content area. When the
        // automation flow reaches clearEditor() → editor.click(), Playwright's
        // actionability check sees the mask intercepting pointer events, retries
        // 55 times, and fails with a 30s timeout (locator.click: Timeout 30000ms
        // exceeded — <div class="mask"> subtree intercepts pointer events).
        //
        // Two-layer defense:
        //   1. mask.click() — simulates user tapping the overlay, which triggers
        //      Kimi's own sidebar-collapse logic (most natural path).
        //   2. mask.style.display = 'none' — fallback if click doesn't stick
        //      (e.g. the event listener sits on a parent element).
        try {
            const dismissed = await page.evaluate(() => {
                const mask = document.querySelector('.mask');
                if (!mask || mask.offsetParent === null) return false;
                mask.click();
                return true;
            });
            if (dismissed) {
                await page.waitForTimeout(1000);
                await page.evaluate(() => {
                    const m = document.querySelector('.mask');
                    if (m && m.offsetParent !== null) m.style.display = 'none';
                }).catch(() => {});
            }
        } catch (_) { /* non-critical — proceed with page default */ }

        // Step 1: Click "新建会话" / "New Chat" to start a fresh conversation,
        // or click "Deep Research" if deep research mode is enabled.
        const isDeepResearch = isDeepResearchActive('kimi');

        if (isDeepResearch) {
            // v35: Deep research opt-in clicks sidebar "Deep Research" entry and skips
            // standard mode / thinking effort steps (DR mode owns the session).
            try {
                const drClicked = await page.evaluate(() => {
                    const drRe = /Deep\s*Research|深度研究|深入研究/i;
                    const candidates = [
                        ...document.querySelectorAll('a, button, [role="button"], [role="link"], div[class*="item"], div[class*="nav"]')
                    ];
                    for (const el of candidates) {
                        const t = (el.textContent || '').trim();
                        if (t.length > 0 && t.length < 40 && drRe.test(t)) {
                            el.click();
                            return true;
                        }
                    }
                    return false;
                });
                if (drClicked) {
                    klog('Deep Research mode entry clicked');
                    await page.waitForTimeout(2500);
                } else {
                    klog('⚠ Deep Research sidebar entry not found');
                }
            } catch (_) { /* non-critical */ }
            return;
        }

        try {
            const clicked = await page.evaluate(() => {
                let btn = document.querySelector('.new-chat-btn');
                if (!btn) {
                    const links = document.querySelectorAll(
                        'a, button, [role="button"], div[class*="new-chat"], div[class*="sidebar-new"]'
                    );
                    const newChatRe = /^New Chat$/i;
                    for (const el of links) {
                        const t = (el.textContent || '').trim();
                        if (t.includes('新建会话') || newChatRe.test(t)) { btn = el; break; }
                    }
                }
                if (btn) { btn.click(); return true; }
                return false;
            });
            if (clicked) await page.waitForTimeout(2500);
        } catch (_) { /* non-critical */ }

        // Step 2: Ensure target mode (Instant default; K3 / K3 Swarm via AGENTCHAT_KIMI_MODE)
        // Best-effort — degrades gracefully to page default if selector not found.
        // Note: K3/K3 Swarm open a new chat, so this must run AFTER new-chat click but BEFORE typing.
        try {
            await ensureKimiMode(page);
        } catch (_) { /* best-effort — proceed with page default */ }

        // Step 3: Ensure Thinking effort (High default; Standard via AGENTCHAT_KIMI_NO_THINK=1).
        // Note: retired ensureKimiDeepThinkOff & AGENTCHAT_KIMI_KEEP_DEEPTHINK in v35.
        try {
            await ensureKimiThinkingEffort(page);
        } catch (_) { /* best-effort */ }
    },

    // v35: exported for tests (factory ignores unknown keys)
    _ensureKimiMode: ensureKimiMode,
    _ensureKimiThinkingEffort: ensureKimiThinkingEffort,
    // v34: sanitizer exported for tests (factory ignores unknown keys)
    _cleanKimiMetaText: cleanKimiMetaText,

    editorSelectors: [
        '.chat-input-editor',
        '[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"]',
        '[role="textbox"]',
    ],

    // ── v26: Kimi's React contenteditable corrupts every async input path
    // (DataTransfer paste, clipboard, keyboard.insertText).  document.execCommand
    // ('insertText') is a synchronous browser-native contenteditable write — one
    // atomic operation that replaces the selection.  React's mutation observer
    // picks up the DOM change post-commit, avoiding the race conditions that
    // shred chunked/keyboard input.  Short prompts go through the same path for
    // consistency.
    input: async (page, editor, prompt) => {
        await editor.focus();
        await page.waitForTimeout(200);
        await editor.evaluate((el, text) => {
            // Select all existing content then replace in one atomic operation
            el.focus();
            const sel = window.getSelection();
            sel.selectAllChildren(el);
            document.execCommand('insertText', false, text);
        }, prompt);
        await page.waitForTimeout(1500);
        return true;
    },

    // ── v26: Use factory clickSend (same as ChatGPT) — enabled-polling,
    // selector rotation, Enter fallback, commit tracking. Replaces the
    // fragile customSend that only knew about .send-button-container.
    sendSelectors: [
        '.send-button-container',          // Kimi-specific primary
        'button[aria-label*="发送"]',
        '[class*="send-btn"]',
        '[class*="send-button"]',
    ],
    sendFallback: 'Enter',

    responseSelectors: RESPONSE_SELECTORS,
    responseSelectorTimeout: 60_000,
    stabilityWindow: 8_000,
    // PERF FIX (2026-07): explicit pollInterval=3000 (was default 2000).
    // Each poll triggers _domProbe which scans DOM elements; 3s vs 2s
    // reduces probe frequency by 33%, cutting reflow-induced scroll cycles.
    pollInterval: 3_000,
    minResponseLength: 10,

    // ── Prevent premature "done" during Kimi's multi-round search pauses ──
    // Kimi's search process: query → pause(5-30s fetch) → analysis → next query → ...
    // During pauses the text stops growing, which fools the stability poller
    // into declaring completion.
    //
    // v11 FIX (field-observed truncations at "正在获取网页..." and
    // "获取网页 5 个网页"): the old tail regexes here had a VOCABULARY GAP —
    // 正在[搜索检索查询] does not contain 获取, and "N 个网页" is not
    // "N 个结果" — so the entire 网页获取 phase was invisible to the check
    // and every fetch longer than the 8s stabilityWindow truncated the run.
    // They were also $-anchored against innerText tails (any trailing
    // source-chip line broke the anchor) and hardcoded to selector [0].
    //
    // Replaced with the shared multi-signal detector (lib/stillWorking.js):
    //   S1 zero-cost classification of the factory-polled text,
    //   S2 visible stop/pause control (wording/locale independent),
    //   S3 spinner inside — or busy tail of — the last response container,
    // with the fetch-phase verbs (获取/抓取/阅读/浏览/…) and "N 个网页"
    // count lines in the vocabulary. False positives are bounded by
    // stillGeneratingMaxHoldMs below instead of burning the budget.
    // v34: the check judges the ANSWER-only container (answerSelector) and
    // holds the clock through the agentic tool phase while toolcall blocks
    // are live and the answer container is still empty (toolcallSelector).
    // Post-answer footer noise ("High demand…", "Reference") never matches
    // the busy vocabulary, so no text sanitizer feeds the check anymore —
    // the postResponseHook applies it to the extracted answer instead.
    stillGeneratingCheck: makeStillWorkingCheck({
        responseSelectors: RESPONSE_SELECTORS,
        answerSelector: KIMI_ANSWER_SEL,
        toolcallSelector: KIMI_TOOLCALL_SEL,
    }),

    // Multi-round search legitimately alternates fetch-silence and text
    // bursts for minutes; the cap re-arms on every REAL text change, so it
    // only bounds a terminal stall (e.g. a final answer whose last line
    // happens to look like a status chip).
    // PERF FIX (2026-07): reduced from 180s to 90s — 3 minutes of polling
    // at 2s intervals meant up to 90 _domProbe executions, each causing
    // layout reflows. 90s is sufficient for Kimi's multi-round search
    // phases (typical: 15-45s), and the cap re-arms on every real text
    // change so it only bounds terminal stalls.
    stillGeneratingMaxHoldMs: 90_000,

    // ── Reject truncated responses (Kimi occasionally stops mid-sentence) ──
    postResponseHook: async (_page, text) => {
        if (text.length < 80 && /^(我来|让我|我将|我会|下面|以下|首先)/.test(text)) {
            return ''; // fails minResponseLength → factory returns error
        }
        // Strip the thinking/search/upgrade/reference meta that Kimi renders
        // inside the answer container, so callers get the clean final answer.
        const cleaned = cleanKimiMetaText(text);
        if (cleaned.length !== text.length) {
            klog(`清理回答元信息 (${text.length} → ${cleaned.length} 字元)`);
        }
        return cleaned;
    },
};
