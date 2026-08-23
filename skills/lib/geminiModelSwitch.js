/**
 * Gemini Model Switcher — ensure Pro Extended Thinking is active.
 *
 * v10 (2026-07-13): "One-time fix" for the recurring model-selector breakage.
 * Root cause of the fix/break/fix cycle: discovery was IDENTIFY-BY-APPEARANCE
 * (CSS/aria selectors describing what the button looks like today). Every
 * Google UI iteration invalidated the description and killed BOTH the Pro and
 * Flash tiers at once. v10 replaces this with four structural changes:
 *
 *   1. VERIFY-BY-EFFECT: findModelButton no longer returns "the" selector.
 *      openModelMenu() iterates ranked candidates, CLICKS each one, and only
 *      accepts a candidate if the model menu ACTUALLY OPENS (menu container /
 *      >=2 filled menu items / cdk-overlay growth). A wrong pick is Escape'd
 *      and skipped — so heuristic tiers are finally safe to trust, and ANY
 *      clickable that opens the menu will eventually be found, regardless of
 *      what Google renames.
 *   2. SELF-HEALING CACHE: the durable selector of the last verified winner is
 *      persisted to $AGENTCHAT_STATE_DIR/gemini-ui-cache.json (default
 *      ~/.agentchat/). Next run tries the cache first (L0) and silently
 *      invalidates it when it stops working. After one successful discovery,
 *      subsequent runs cost a single click even if L1/L2 lists are stale.
 *   3. READINESS GATE: waitForAppReady() polls for the app shell (editor)
 *      before discovery starts. The old code raced Angular hydration — on
 *      slow loads all 3 tiers exhausted BEFORE the toolbar rendered, which is
 *      why the bug looked intermittent ("fixed" on fast loads, "back" on cold
 *      ones).
 *   4. SHADOW-DOM PIERCING: L1/L2 use Playwright locators (which pierce open
 *      shadow roots natively), and the L3 scan + diagnostics dump now walk
 *      shadow roots explicitly. document.querySelector-based aria reads were
 *      replaced by locator-based reads for the same reason — a toolbar
 *      migrated into a web component is no longer invisible to us.
 *
 * Failure POLICY moved to the adapter (see adapters/gemini.js): model
 * activation failure fail-closes the Gemini provider, allowing the normal
 * fallback chain to continue instead of using an unverified stale tab.
 *
 * v9 history preserved: flat-menu Extended selection with nested-submenu
 * fallback, aria-label locale correction, modelVerify-based verification.
 * v6 history preserved: Angular CDK overlay text-fill polling.
 *
 * This is the CANONICAL implementation — used by OneWeb.
 *
 * Usage:
 *   const { ensureProExtended } = require('../lib/geminiModelSwitch');
 *   const ok = await ensureProExtended(page, maxRetries, onLog);
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_RETRIES = 2;

// v7: 选择器集中管理。所有语言相关文本从 locales/gemini.js 读取，
// 不再硬编码任何 zh-TW / zh-CN / en / ja 关键字。
// 新增语言只需在 locales/gemini.js 追加一个 profile。
const L = require('./locales/gemini');

// ── txt() normalization ──────────────────────────────────────────────────────
// P0 FIX (profile-mode type confusion): L.txt(key) returns a plain STRING when
// an exact locale profile is active and a RegExp ONLY in fuzzy-fallback mode.
// asRe() converts either form to a case-insensitive RegExp; profile strings are
// literal UI text, so regex metacharacters are escaped.
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const asRe = (v) => (v instanceof RegExp ? v : new RegExp(escapeRe(v), 'i'));

// v9: modelVerify checks the activated *thinking* state. All current models
// support Extended Thinking, so it is NOT sufficient proof of the Pro model.
const includesExtended  = (t) => asRe(L.txt('modelVerify')).test(t)
    || asRe(L.txt('extended')).test(t);  // fallback for old UI where extended is in aria
const includesStandard  = (t) => asRe(L.txt('standard')).test(t);
const isProExtendedAria = (t) => /\bPro\b/i.test(String(t || '')) && includesExtended(t);
// Pro model check: innerText 含 "Pro" 且含当前 locale 的 proDesc
const proDesc           = () => asRe(L.txt('proDesc'));
const modelBtnSelector  = () => L.modelBtnCSS();

// Default Flash is the newest full Flash item actually present in the
// verified model menu, plus independently selected Extended Thinking.
// Do not pin a literal version (e.g. 3.6): locales may already have retired
// that label. Never Lite/Pro/Ultra, never generic composer "Flash".
const DEFAULT_FLASH_MODEL = Object.freeze({
    id: 'newest-full-flash',
    displayName: 'newest full Flash',
});

const FLASH_TIER_RE = /\b(?:Lite|Pro|Ultra)\b/i;
const FLASH_WORD_RE = /\bFlash\b/i;
const LEADING_VERSION_RE = /^(\d+(?:\.\d+)*)/;

function normalizeMenuText(text) {
    return String(text || '').trim().replace(/\s+/g, ' ');
}

function parseLeadingModelVersion(text) {
    const m = normalizeMenuText(text).match(LEADING_VERSION_RE);
    return m ? m[1] : null;
}

function compareModelVersions(a, b) {
    const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const da = pa[i] || 0;
        const db = pb[i] || 0;
        if (da !== db) return da - db;
    }
    return 0;
}

function isDefaultFlashText(text) {
    const normalized = normalizeMenuText(text);
    if (!FLASH_WORD_RE.test(normalized)) return false;
    if (FLASH_TIER_RE.test(normalized)) return false;
    return !!parseLeadingModelVersion(normalized);
}

function flashMenuLabel(itemOrText) {
    const text = (typeof itemOrText === 'string' || itemOrText == null)
        ? itemOrText
        : itemOrText.text;
    const normalized = normalizeMenuText(text);
    const m = normalized.match(/^(\d+(?:\.\d+)*)\s+Flash\b/i);
    return m ? `${m[1]} Flash` : (normalized || DEFAULT_FLASH_MODEL.displayName);
}

function pickNewestFullFlash(items) {
    if (!Array.isArray(items)) return null;
    let best = null;
    let bestVer = null;
    for (const item of items) {
        if (!item || !isDefaultFlashText(item.text)) continue;
        const ver = parseLeadingModelVersion(item.text);
        if (!ver) continue;
        if (!best || compareModelVersions(ver, bestVer) > 0) {
            best = item;
            bestVer = ver;
        }
    }
    return best;
}

function isSelectedGeminiModelItem(item) {
    return !!(item && (item.selected === true
        || String(item.ariaSelected || '').toLowerCase() === 'true'
        || String(item.ariaChecked || '').toLowerCase() === 'true'));
}

function isDefaultFlashItem(item) {
    return isSelectedGeminiModelItem(item) && isDefaultFlashText(item.text);
}

const EXTENDED_THINKING_RE = /(?:延伸思考|延長思考|扩展思考|Extended\s+thinking|拡張思考)/i;

function isExtendedThinkingText(text) {
    return EXTENDED_THINKING_RE.test(String(text || '').trim());
}

function isDefaultFlashExtendedMenuState(items) {
    if (!Array.isArray(items)) return false;
    const newest = pickNewestFullFlash(items);
    return !!(newest && isSelectedGeminiModelItem(newest)
        && items.some(item => isSelectedGeminiModelItem(item)
            && isExtendedThinkingText(item && item.text)));
}

/**
 * Model menu proof data is deliberately plain JSON so it can be both returned
 * across Playwright's page boundary and tested without a browser.
 */
function isGeminiModelMenuItems(items) {
    if (!Array.isArray(items)) return false;
    const identified = items.filter(item => {
        if (!item || !String(item.text || '').trim()) return false;
        return !!item.dataModeId
            || /^bard-mode-option-/i.test(String(item.dataTestId || ''));
    });
    return identified.length >= 2;
}

function selectedGeminiModelText(items) {
    if (!Array.isArray(items)) return '';
    const selected = items.find(item => item && isSelectedGeminiModelItem(item)
        && String(item.text || '').trim());
    return selected ? String(selected.text).trim() : '';
}

const GEMINI_MODE_BUTTON_SELECTOR = '[data-test-id="bard-mode-menu-button"]';
const GEMINI_MODEL_OPTION_SELECTOR =
    'gem-menu-item[data-mode-id], [data-test-id^="bard-mode-option-"]';

// The thinking-level row belongs to the same menu but has no data-mode-id.
// Keep it separate so model-menu proof still requires actual model options.
const EXTENDED_THINKING_OPTION_SELECTOR =
    'gem-menu-item:not([data-mode-id]):not([data-test-id^="bard-mode-option-"])';

const MODEL_BUTTON_CACHE_KIND = 'gemini-model-button';
const MODEL_BUTTON_CACHE_VERSION = 2;

// ── v10: selector cache (self-healing persistence) ───────────────────────────
// Skill mounts are frequently READ-ONLY (see lib/telemetry.js rationale), so
// the cache lives OUTSIDE the repo by default. Everything is best-effort: a
// missing/corrupt/unwritable cache degrades to plain L1→L2→L3 discovery.

const CACHE_FILE = 'gemini-ui-cache.json';

function stateDir() {
    return process.env.AGENTCHAT_STATE_DIR
        || path.join(os.homedir(), '.agentchat');
}

function cachePath() { return path.join(stateDir(), CACHE_FILE); }

function loadCache() {
    try {
        const parsed = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
        if (!parsed || typeof parsed !== 'object') return {};

        // v33/v34: pre-v33 entries were only "a selector that opened some menu".
        // Treat them as untrusted: an Upload tools selector was cached in the
        // field and silently caused default-Flash calls to run under 3.1 Pro.
        const btn = parsed.modelButton;
        if (btn && (btn.kind !== MODEL_BUTTON_CACHE_KIND
            || btn.version !== MODEL_BUTTON_CACHE_VERSION
            || typeof btn.sel !== 'string')) {
            delete parsed.modelButton;
            try { fs.writeFileSync(cachePath(), JSON.stringify(parsed, null, 2)); } catch (_) {}
        }
        return parsed;
    } catch (_) { return {}; }
}

function saveCache(patch) {
    try {
        const next = { ...loadCache(), ...patch };
        fs.mkdirSync(stateDir(), { recursive: true });
        fs.writeFileSync(cachePath(), JSON.stringify(next, null, 2));
    } catch (_) { /* cache is best-effort */ }
}

function dropCache(key) {
    try {
        const cur = loadCache();
        if (key in cur) {
            delete cur[key];
            fs.writeFileSync(cachePath(), JSON.stringify(cur, null, 2));
        }
    } catch (_) { /* cache is best-effort */ }
}

// ── Candidate tiers ──────────────────────────────────────────────────────────

/** L2: Structured candidates — language-independent DOM landmarks.
 *  Ordered most-specific → most-generic. False positives are CHEAP now
 *  (verify-by-effect Escapes and moves on), but each wrong click costs ~1-2s,
 *  so specificity ordering still matters. */
const MODEL_BTN_CANDIDATES = [
    GEMINI_MODE_BUTTON_SELECTOR,
    '[data-test-id*="mode-menu"]',
    '[data-testid*="mode-menu"]',
    '[data-test-id*="model"]',
    '[data-testid*="model"]',
    'bard-mode-switcher button',
    'mode-switcher button',
    '[class*="mode-switcher"] button',
    'button:has(.logo-pill-label-container)',
    '[class*="mode-switcher"]',
    '[class*="model-switcher"]',
    '[class*="modelSwitcher"]',
    'button[aria-haspopup]:has([class*="logo"])',
    'button[aria-haspopup]:has([class*="pill"])',
    '[aria-label*="mode" i]',
    '[aria-label*="model" i]',
];

/** L3: Model-related keywords for heuristic button text/aria scanning. */
const MODEL_KEYWORDS = [
    'Pro', 'Flash', 'Thinking', 'Extended', 'Standard',
    'Advanced', 'Fast',
    '扩展', '延長', '延伸', '拡張', '思考', '模型', '模式', 'モデル',
    '2.5', '3.0', '2.0', '3.5', '3.1', '3.6', '3.7',
];

/** L3 + pre-click guard: common non-model buttons to skip outright. */
const NON_MODEL_KEYWORDS = [
    '設定', '设置', 'Settings',
    '帮助', '幫助', 'Help',
    '通知', 'Notifications',
    '菜单', '選單', 'Menu',
    '分享', 'Share',
    '刪除', '删除', 'Delete',
    '重命名', 'Rename',
    '釘選', 'Pin',
    '发送', '傳送', 'Send', '送信',
    '麦克风', '麥克風', 'Microphone', 'マイク',
    '语音', '語音', 'Voice',
    '上传', '上傳', '上載', 'Upload', 'Attach', '附加',
    '新对话', '新對話', 'New chat',
];

const NON_MODEL_RE = new RegExp(
    NON_MODEL_KEYWORDS.map(escapeRe).join('|'), 'i'
);

// ── v10: readiness gate ──────────────────────────────────────────────────────
// The #1 hidden failure mode: discovery raced Angular hydration. L1 (800ms) +
// L2 (400ms each) + L3 all completed before the toolbar existed on slow/cold
// loads. Gate on the app shell first; the editor is the strongest "app booted"
// signal and is already selector-managed in locales.

async function waitForAppReady(page, log, timeoutMs = 15000) {
    const start = Date.now();
    const hasSpecificModelButton = async () => {
        for (const sel of [GEMINI_MODE_BUTTON_SELECTOR, modelBtnSelector()]) {
            try {
                if (await page.locator(sel).first().isVisible({ timeout: 200 }).catch(() => false)) return true;
            } catch (_) {}
        }
        return false;
    };
    let editorSeenAt = 0;
    while (Date.now() - start < timeoutMs) {
        if (await hasSpecificModelButton()) {
            await page.waitForTimeout(300);
            return true;
        }
        try {
            const editorVisible = await page.locator(L.STATIC.editor).first()
                .isVisible({ timeout: 250 }).catch(() => false);
            if (editorVisible && !editorSeenAt) editorSeenAt = Date.now();
        } catch (_) { /* visibility probe is best-effort */ }
        // Do not let an already-mounted editor make us race a lazy model
        // switcher. Wait a bounded 8s after editor visibility; then the normal
        // discovery/diagnostics path can explain a genuine selector drift.
        if (editorSeenAt && Date.now() - editorSeenAt >= 8000) break;
        await page.waitForTimeout(500);
    }
    log('gemini WARN: app-ready gate timed out waiting for model button — proceeding to diagnostics');
    return false;
}

// ── v10: shadow-piercing element reads ──────────────────────────────────────
// Playwright locators pierce open shadow roots; document.querySelector does
// NOT. Every aria/text read now goes through a locator.

async function readAria(page, sel) {
    try {
        return await page.locator(sel).first().evaluate(el =>
            (el.getAttribute('aria-label') || el.textContent || '').trim()
        );
    } catch (_) { return ''; }
}

// ── v33/v34: Gemini-model-menu proof ─────────────────────────────────────
// A generic overlay is not enough: clicking Upload tools also opens a menu with
// text-filled items. Persisting that button poisoned the selector cache and let
// default Flash requests silently run with the preselected Pro model.

async function readVisibleGeminiModelMenuItems(page) {
    try {
        return await page.locator(GEMINI_MODEL_OPTION_SELECTOR).evaluateAll(els =>
            els.filter(el => {
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                return rect.width > 0 && rect.height > 0
                    && style.display !== 'none' && style.visibility !== 'hidden';
            }).map(el => ({
                text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' '),
                dataModeId: el.getAttribute('data-mode-id') || '',
                dataTestId: el.getAttribute('data-test-id') || el.getAttribute('data-testid') || '',
                selected: el.classList.contains('selected')
                    || !!el.querySelector('.selected, [aria-label*="已選取"], [aria-label*="Selected"]'),
                ariaSelected: el.getAttribute('aria-selected') || '',
                ariaChecked: el.getAttribute('aria-checked') || '',
            }))
        );
    } catch (_) { return []; }
}

async function readVisibleExtendedThinkingItems(page) {
    try {
        return await page.locator(EXTENDED_THINKING_OPTION_SELECTOR).evaluateAll(
            (els, reData) => {
                const re = new RegExp(reData.source, reData.flags);
                return els.filter(el => {
                    const rect = el.getBoundingClientRect();
                    const style = getComputedStyle(el);
                    const text = (el.innerText || el.textContent || '').trim();
                    return rect.width > 0 && rect.height > 0
                        && style.display !== 'none' && style.visibility !== 'hidden'
                        && re.test(text);
                }).map(el => ({
                    text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' '),
                    selected: el.classList.contains('selected')
                        || !!el.querySelector('.selected, [aria-label*="已選取"], [aria-label*="Selected"]'),
                    ariaSelected: el.getAttribute('aria-selected') || '',
                    ariaChecked: el.getAttribute('aria-checked') || '',
                }));
            },
            { source: EXTENDED_THINKING_RE.source, flags: EXTENDED_THINKING_RE.flags }
        );
    } catch (_) { return []; }
}

async function readVisibleGeminiMenuState(page) {
    const [models, extended] = await Promise.all([
        readVisibleGeminiModelMenuItems(page),
        readVisibleExtendedThinkingItems(page),
    ]);
    return [...models, ...extended];
}

async function findVisibleExtendedThinkingOption(page) {
    const locator = page.locator(EXTENDED_THINKING_OPTION_SELECTOR).filter({
        hasText: EXTENDED_THINKING_RE,
    });
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index++) {
        const candidate = locator.nth(index);
        if (await candidate.isVisible({ timeout: 300 }).catch(() => false)) return candidate;
    }
    return null;
}

async function ensureExtendedThinkingInOpenMenu(page, log) {
    const state = await readVisibleGeminiMenuState(page);
    const extended = state.find(item => isExtendedThinkingText(item && item.text));
    if (!extended) {
        log('gemini WARN: Extended Thinking item not found in verified model menu.');
        return false;
    }
    if (isSelectedGeminiModelItem(extended)) {
        log('gemini: Extended Thinking already selected.');
        return true;
    }
    const option = await findVisibleExtendedThinkingOption(page);
    if (!option) {
        log('gemini WARN: Extended Thinking item not found for selection.');
        return false;
    }
    try {
        await option.click({ timeout: 3000 });
        log('gemini: selected Extended Thinking.');
        return true;
    } catch (_) {
        log('gemini WARN: Extended Thinking item not clickable.');
        return false;
    }
}

/**
 * Return the structured model menu only after the Gemini-specific mode options
 * render. Generic uploads/settings menus deliberately return null.
 */
async function waitForGeminiModelMenu(page, timeoutMs = 2500) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const items = await readVisibleGeminiModelMenuItems(page);
        if (isGeminiModelMenuItems(items)) return items;
        await page.waitForTimeout(200);
    }
    return null;
}

// ── v10: L3 heuristic scan (shadow-piercing, multi-candidate, durable ids) ──

/**
 * Heuristic scan across document + all open shadow roots. Tags the top-N
 * candidates with data-fs-fallback="1..N" for immediate clicking and returns
 * a DURABLE descriptor per candidate (data-test-id / aria-label based) that
 * survives page reloads — that is what gets cached, never the ephemeral tag.
 *
 * @returns {Promise<Array<{sel: string, durable: string|null, score: number, text: string}>>}
 */
async function heuristicCandidates(page, log, maxTag = 3) {
    const out = await page.evaluate(({ keywords, nonKeywords, maxTag }) => {
        // Collect document + every open shadow root
        const roots = [document];
        try {
            const walker = document.createTreeWalker(
                document.documentElement, NodeFilter.SHOW_ELEMENT
            );
            let n;
            while ((n = walker.nextNode())) {
                if (n.shadowRoot) roots.push(n.shadowRoot);
            }
        } catch (_) { /* shadow walk is best-effort */ }

        // Clear stale tags from previous scans (attribute may survive
        // in-place re-renders and would otherwise alias old elements).
        for (const r of roots) {
            try {
                r.querySelectorAll('[data-fs-fallback]')
                    .forEach(el => el.removeAttribute('data-fs-fallback'));
            } catch (_) {}
        }

        const seen = new Set();
        const els = [];
        for (const r of roots) {
            let list = [];
            try {
                list = r.querySelectorAll(
                    'button:not([disabled]), [role="button"]:not([disabled]), [aria-haspopup]'
                );
            } catch (_) { continue; }
            for (const el of list) {
                if (!seen.has(el)) { seen.add(el); els.push(el); }
            }
        }

        const candidates = [];
        for (const el of els) {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const style = getComputedStyle(el);
            if (style.visibility === 'hidden' || style.display === 'none') continue;
            if (el.closest('a[href]')) continue; // links can navigate away

            const text = (el.textContent || '').trim();
            const aria = (el.getAttribute('aria-label') || '').trim();
            const combined = text + ' ' + aria;
            const lower = combined.toLowerCase();
            const testId = (
                el.getAttribute('data-test-id') || el.getAttribute('data-testid') || ''
            ).toLowerCase();

            // Negative filter: skip obvious non-model buttons entirely
            const isNonModel = nonKeywords.some(kw => lower.includes(kw.toLowerCase()));
            if (isNonModel && text.length < 30) continue;

            let score = 0;
            for (const kw of keywords) {
                if (lower.includes(kw.toLowerCase())) score++;
            }
            if (el.hasAttribute('aria-haspopup')) score += 3;
            if (rect.top < 200) score += 1;
            if (/(model|mode|bard)/.test(testId)) score += 5;

            if (score > 0) candidates.push({ el, score, text: combined.slice(0, 120) });
        }

        candidates.sort((a, b) => b.score - a.score);

        const result = [];
        for (let i = 0; i < Math.min(maxTag, candidates.length); i++) {
            const { el, score, text } = candidates[i];
            el.setAttribute('data-fs-fallback', String(i + 1));

            // Build a durable descriptor for cross-load caching
            let durable = null;
            const tid1 = el.getAttribute('data-test-id');
            const tid2 = el.getAttribute('data-testid');
            const ar = el.getAttribute('aria-label');
            if (tid1 && !tid1.includes('"')) durable = `[data-test-id="${tid1}"]`;
            else if (tid2 && !tid2.includes('"')) durable = `[data-testid="${tid2}"]`;
            else if (ar && ar.length <= 60 && !ar.includes('"')) {
                durable = `button[aria-label*="${ar}"]`;
            }

            result.push({
                sel: `[data-fs-fallback="${i + 1}"]`,
                durable, score, text,
            });
        }
        return result;
    }, { keywords: MODEL_KEYWORDS, nonKeywords: NON_MODEL_KEYWORDS, maxTag });

    for (const c of out) {
        log(`gemini: L3 heuristic candidate score=${c.score} text="${c.text}"`);
    }
    return out;
}

// ── v10: verify-by-effect menu opener (replaces single-shot findModelButton) ─

/**
 * Open the Gemini model menu, whatever the button looks like this week.
 *
 * Candidate order: L0 cache → L1 locale aria CSS → L2 structural landmarks →
 * L3 heuristic scan (lazily appended when the static tiers run dry). Each
 * candidate is clicked and accepted ONLY if the menu verifiably opens; wrong
 * picks are Escape'd and skipped. The verified winner's durable selector is
 * persisted for next run.
 *
 * On total failure: dumps button diagnostics (shadow-piercing) and returns null.
 *
 * @param {Page} page
 * @param {(msg: string) => void} log
 * @param {{budgetMs?: number, maxClicks?: number}} [opts]
 * @returns {Promise<{sel: string}|null>} selector that opened the menu, or null
 */
async function openModelMenu(page, log, opts = {}) {
    const budgetMs = opts.budgetMs || 20000;
    const maxClicks = opts.maxClicks || 8;

    const queue = [];
    const seenSel = new Set();
    const push = (sel, tier, durable) => {
        if (!sel || seenSel.has(sel)) return;
        seenSel.add(sel);
        queue.push({ sel, tier, durable });
    };

    // L0: cache
    const cached = loadCache().modelButton;
    if (cached && cached.sel) push(cached.sel, 'L0-cache', cached.sel);
    // L1: locale aria CSS
    push(modelBtnSelector(), 'L1-locale', null);
    // L2: structural landmarks
    for (const sel of MODEL_BTN_CANDIDATES) push(sel, 'L2-structural', null);

    const start = Date.now();
    let clicks = 0;
    let l3Appended = false;

    while (true) {
        if (queue.length === 0) {
            if (l3Appended) break;
            l3Appended = true;
            const l3 = await heuristicCandidates(page, log).catch(() => []);
            for (const c of l3) push(c.sel, 'L3-heuristic', c.durable);
            if (queue.length === 0) break;
        }
        if (Date.now() - start > budgetMs || clicks >= maxClicks) {
            log(`gemini WARN: openModelMenu budget exhausted (clicks=${clicks}, ms=${Date.now() - start})`);
            break;
        }

        const { sel, tier, durable } = queue.shift();
        const loc = page.locator(sel).first();

        // L1/L2 are reliable structural selectors — give them enough time for
        // Angular hydration + shadow DOM rendering on a fresh page. Pre-v24
        // budget (400/800ms) was tuned for cached/warm pages and caused
        // "Model selector button not found" on every cold start.
        const visTimeout = tier === 'L0-cache' ? 800
            : tier === 'L1-locale' ? 4000
            : 2500; // L2-structural, L3-heuristic
        const visible = await loc
            .isVisible({ timeout: visTimeout })
            .catch(() => false);
        if (!visible) {
            if (tier === 'L0-cache') {
                log('gemini: cached model-button selector stale — invalidating');
                dropCache('modelButton');
            }
            continue;
        }

        // Pre-click guard: cheaply skip obvious non-model widgets
        const label = await readAria(page, sel);
        if (label && label.length < 30 && NON_MODEL_RE.test(label)) continue;

        clicks++;
        try {
            await loc.click({ timeout: 3000 });
        } catch (_) {
            if (tier === 'L0-cache') dropCache('modelButton');
            continue;
        }

        const menuItems = await waitForGeminiModelMenu(page);
        if (menuItems) {
            log(`gemini: verified model menu opened via ${tier} "${sel}"`);
            // Persist only a selector that produced Gemini-specific mode
            // options. L3's data-fs tag is ephemeral — cache its durable form.
            const durableSel = durable
                || (tier === 'L1-locale' || tier === 'L2-structural' ? sel : null);
            if (durableSel) {
                saveCache({ modelButton: {
                    sel: durableSel,
                    tier,
                    kind: MODEL_BUTTON_CACHE_KIND,
                    version: MODEL_BUTTON_CACHE_VERSION,
                    verifiedAt: Date.now(),
                } });
            }
            return { sel };
        }

        log(`gemini: ${tier} candidate "${sel}" clicked but no Gemini model menu opened — next`);
        if (tier === 'L0-cache') dropCache('modelButton');
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300);
    }

    await dumpButtonDiagnostics(page, log);
    return null;
}

/**
 * Read the model button's current aria/text WITHOUT opening the menu —
 * used for the idempotency check ("Pro Extended already active?").
 * Best-effort: returns null when nothing plausible is visible.
 */
async function peekModelButtonAria(page) {
    const sels = [];
    const cached = loadCache().modelButton;
    if (cached && cached.sel) sels.push(cached.sel);
    // Only known model-button selectors belong here. Never append broad L2/L3
    // candidates: Upload tools has aria-haspopup and was previously misread as
    // the selected model, poisoning the Flash and Pro idempotency checks.
    sels.push(GEMINI_MODE_BUTTON_SELECTOR, modelBtnSelector());

    for (const sel of [...new Set(sels)]) {
        try {
            const loc = page.locator(sel).first();
            const vis = await loc.isVisible({ timeout: 300 }).catch(() => false);
            if (!vis) continue;
            const aria = await readAria(page, sel);
            if (aria) return { sel, aria };
        } catch (_) { /* next */ }
    }
    return null;
}

/**
 * Dump top ~15 visible buttons' diagnostics to stderr — now shadow-piercing.
 * When the model button can't be found, this output is the single source of
 * truth for a one-minute fix — no blind guessing about what Google changed.
 */
async function dumpButtonDiagnostics(page, log) {
    try {
        const info = await page.evaluate(() => {
            const roots = [document];
            try {
                const walker = document.createTreeWalker(
                    document.documentElement, NodeFilter.SHOW_ELEMENT
                );
                let n;
                while ((n = walker.nextNode())) {
                    if (n.shadowRoot) roots.push(n.shadowRoot);
                }
            } catch (_) {}

            const seen = new Set();
            const items = [];
            for (const r of roots) {
                let list = [];
                try {
                    list = r.querySelectorAll(
                        'button:not([disabled]), [role="button"]:not([disabled]), [aria-haspopup]'
                    );
                } catch (_) { continue; }
                for (const el of list) {
                    if (seen.has(el)) continue;
                    seen.add(el);
                    const rect = el.getBoundingClientRect();
                    if (rect.width === 0 || rect.height === 0) continue;
                    const style = getComputedStyle(el);
                    if (style.visibility === 'hidden' || style.display === 'none') continue;

                    items.push({
                        tag: el.tagName,
                        text: (el.textContent || '').trim().slice(0, 80),
                        aria: (el.getAttribute('aria-label') || '').slice(0, 80),
                        hasPopup: el.hasAttribute('aria-haspopup'),
                        classes: (typeof el.className === 'string' ? el.className : '').slice(0, 120),
                        testId: (el.getAttribute('data-test-id') || el.getAttribute('data-testid') || '').slice(0, 60),
                        top: Math.round(rect.top),
                        shadow: r !== document,
                    });
                    if (items.length >= 15) return items;
                }
            }
            return items;
        });

        log('gemini DIAG: top visible buttons (model button not found):');
        info.forEach((b, i) => {
            log(`  [${i}] <${b.tag}>${b.shadow ? ' [shadow]' : ''} top=${b.top} popup=${b.hasPopup} text="${b.text}" aria="${b.aria}" class="${b.classes}" testid="${b.testId}"`);
        });
    } catch (e) {
        log(`gemini DIAG: button dump failed: ${e.message}`);
    }
}

// Helper: wait for Gemini mode items to have actual text content (Angular CDK overlay fix)
async function waitForMenuItemsFilled(page, timeoutMs = 5000) {
    return !!(await waitForGeminiModelMenu(page, timeoutMs));
}

/** v9→v10 factored: infer UI locale from the model button's aria/text.
 *  Button text is the authoritative source of the page's ACTUAL language —
 *  navigator.language can disagree (browser zh-CN, Gemini UI zh-TW).
 *  v10: added 延伸 (new zh-TW wording) alongside 延長. */
function inferLocaleFromAria(aria) {
    if (!aria || aria === 'UNKNOWN') return null;
    return L.inferLocaleFromButtonText(aria);
}

function maybeCorrectLocale(aria, log) {
    const corrected = inferLocaleFromAria(aria);
    if (corrected && corrected !== L.locale) {
        log(`gemini: correcting locale ${L.locale || 'fuzzy'} → ${corrected} (from button aria-label)`);
        L.setLocale(corrected);
    }
}

/**
 * Switch Gemini to Pro + Extended Thinking mode. Idempotent — skips if already active.
 *
 * @param {Page} page — Playwright page on gemini.google.com
 * @param {number} [maxRetries=2]
 * @param {(msg: string) => void} [onLog] — log callback (default: silent)
 * @returns {Promise<boolean>} true if Pro Extended is active
 */
async function ensureProExtended(page, maxRetries = MAX_RETRIES, onLog) {
    const log = onLog || (() => {});

    // Auto-detect Gemini UI locale on first call
    if (!L.locale) {
        const detected = await L.detectLocale(page);
        L.setLocale(detected);
        if (detected) log(`gemini: detected locale ${detected}`);
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
            log(`gemini: retry ${attempt}/${maxRetries} — reloading page`);
            try {
                const currentUrl = page.url();
                await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForTimeout(3000);
            } catch (_) {}
        }

        // Dismiss any open overlays
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);

        // v10: gate on app shell BEFORE discovery — kills the hydration race
        await waitForAppReady(page, log);

        // Idempotency peek: read current mode without opening the menu
        const peek = await peekModelButtonAria(page);
        let currentAria = 'UNKNOWN';
        if (peek) {
            currentAria = peek.aria;
            log(`gemini attempt ${attempt}: current mode = "${currentAria}"`);
            maybeCorrectLocale(currentAria, log);
            if (isProExtendedAria(currentAria)) {
                log('gemini: Pro Extended Thinking already active');
                return true;
            }
        }

        // Step 1: open the model menu (verify-by-effect discovery)
        const opened = await openModelMenu(page, log);
        if (!opened) {
            log('gemini WARN: Model selector button not found (cache→L1→L2→L3 exhausted).');
            continue;
        }
        const mbs = opened.sel;

        // Menu is open at this point — wait for Angular CDK text fill
        if (!(await waitForMenuItemsFilled(page))) {
            log('gemini WARN: Menu items never got innerText (Angular CDK rendering timeout).');
            await page.keyboard.press('Escape').catch(() => {});
            continue;
        }

        // If we could not peek earlier, read state from the (now known) button
        if (!peek) {
            currentAria = (await readAria(page, mbs)) || 'UNKNOWN';
            log(`gemini attempt ${attempt}: current mode = "${currentAria}"`);
            maybeCorrectLocale(currentAria, log);
            if (isProExtendedAria(currentAria)) {
                log('gemini: Pro Extended Thinking already active');
                await page.keyboard.press('Escape').catch(() => {});
                return true;
            }
        }

        // Step 2: Ensure Pro model (skip Flash variants)
        const modeIsPro = currentAria.includes('Pro') && !currentAria.includes('Flash');
        if (!modeIsPro) {
            log('gemini: switching to Pro model');
            try {
                const _pd = proDesc();
                const proIdx = await page.evaluate(({ itemSel, pd }) => {
                    const items = document.querySelectorAll(itemSel);
                    const re = new RegExp(pd.source, pd.flags);
                    for (let i = 0; i < items.length; i++) {
                        const t = items[i].innerText || '';
                        if (t.includes('Pro') && re.test(t) && !t.includes('Flash')) return i;
                    }
                    return -1;
                }, { itemSel: L.STATIC.menuItem, pd: { source: _pd.source, flags: _pd.flags } });
                if (proIdx < 0) throw new Error('Pro item not found');

                await page.locator(L.STATIC.menuItem).nth(proIdx).click();
                await page.waitForTimeout(2000);

                // Model switch often closes menu — reopen for thinking level.
                // openModelMenu is cheap on the second call (verified cache hit).
                const reopened = await openModelMenu(page, log);
                if (!reopened) {
                    log('gemini WARN: could not reopen model menu after Pro switch.');
                    continue;
                }
                if (!(await waitForMenuItemsFilled(page))) {
                    log('gemini WARN: Menu items after Pro switch never filled.');
                    continue;
                }
            } catch {
                log('gemini WARN: Failed to switch to Pro model.');
                continue;
            }
        }

        // Step 3: Select Extended Thinking
        // v9: Google redesigned model picker to a FLAT menu — "Extended
        // thinking" is a direct menu item. Fallback: old nested submenu.
        const _extRe = asRe(L.txt('extended')); const _thinkRe = asRe(L.txt('thinking'));
        let extendedIdx = await page.evaluate(({ itemSel, extSrc, extFlags, thinkSrc, thinkFlags }) => {
            const items = document.querySelectorAll(itemSel);
            const extRe = new RegExp(extSrc, extFlags);
            const thinkRe = new RegExp(thinkSrc, thinkFlags);
            for (let i = 0; i < items.length; i++) {
                const t = items[i].innerText || '';
                if (extRe.test(t) && !thinkRe.test(t) && items[i].offsetParent !== null) return i;
            }
            return -1;
        }, { itemSel: L.STATIC.menuItem, extSrc: _extRe.source, extFlags: _extRe.flags, thinkSrc: _thinkRe.source, thinkFlags: _thinkRe.flags });

        if (extendedIdx < 0) {
            // v9 fallback: old nested-submenu expansion (for pre-July-2026 UI)
            log('gemini: flat-menu extended not found, trying old submenu expansion...');
            try {
                const _tr = asRe(L.txt('thinking'));
                const thinkIdx = await page.evaluate(({ itemSel, thinkSrc, thinkFlags }) => {
                    const items = document.querySelectorAll(itemSel);
                    const re = new RegExp(thinkSrc, thinkFlags);
                    for (let i = 0; i < items.length; i++) {
                        const t = items[i].innerText || '';
                        if (re.test(t) && items[i].offsetParent !== null) return i;
                    }
                    return -1;
                }, { itemSel: L.STATIC.menuItem, thinkSrc: _tr.source, thinkFlags: _tr.flags });
                if (thinkIdx < 0) {
                    // Dump menu items to diagnose what Google changed
                    try {
                        const menuSnapshot = await page.evaluate(() => {
                            const items = document.querySelectorAll(
                                'gem-menu-item, [role="menuitem"], [role="menuitemradio"], '
                                + '[role="option"], [role="listitem"], .menu-item, '
                                + '[class*="menuItem"], [class*="menu-item"], li'
                            );
                            const out = [];
                            for (const el of items) {
                                const t = (el.innerText || '').trim();
                                if (!t) continue;
                                out.push({
                                    tag: el.tagName,
                                    text: t.slice(0, 100),
                                    visible: el.offsetParent !== null,
                                    role: el.getAttribute('role') || '',
                                    classes: (typeof el.className === 'string' ? el.className : '').slice(0, 100),
                                });
                            }
                            return out;
                        });
                        log('gemini DIAG: menu items dump (extended thinking not found):');
                        menuSnapshot.forEach((m, i) => {
                            log(`  [${i}] <${m.tag}> role="${m.role}" visible=${m.visible} text="${m.text}" class="${m.classes}"`);
                        });
                    } catch (e) { log(`gemini DIAG: menu dump failed: ${e.message}`); }
                    throw new Error('Extended thinking item not found in menu');
                }

                await page.locator(L.STATIC.menuItem).nth(thinkIdx).click();
                await page.waitForTimeout(2000);

                // Re-query: Extended should now be visible in submenu
                const _ext2 = asRe(L.txt('extended')); const _std2 = asRe(L.txt('standard'));
                extendedIdx = await page.evaluate(({ itemSel, extSrc, extFlags, stdSrc, stdFlags }) => {
                    const items = document.querySelectorAll(itemSel);
                    const extRe = new RegExp(extSrc, extFlags);
                    const stdRe = new RegExp(stdSrc, stdFlags);
                    for (let i = 0; i < items.length; i++) {
                        const t = items[i].innerText || '';
                        if (extRe.test(t) && !stdRe.test(t) && items[i].offsetParent !== null) return i;
                    }
                    return -1;
                }, { itemSel: L.STATIC.menuItem, extSrc: _ext2.source, extFlags: _ext2.flags, stdSrc: _std2.source, stdFlags: _std2.flags });
                if (extendedIdx < 0) throw new Error('Extended option not found after submenu expansion');
            } catch {
                log('gemini WARN: Could not select extended thinking (both flat & nested paths failed).');
                continue;
            }
        }

        // Step 4: Click Extended
        try {
            await page.locator(L.STATIC.menuItem).nth(extendedIdx).click();
            log('gemini: selected Extended thinking');
        } catch {
            log('gemini WARN: Extended button not clickable.');
            continue;
        }

        // Step 5: Close menu and verify
        await page.keyboard.press('Escape');
        await page.locator(L.STATIC.overlayBackdrop).waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(1000);

        // Verify via aria-label (authoritative source), shadow-safe. The
        // wording now overlaps with Flash Extended, so require BOTH Pro
        // identity and Extended Thinking rather than merely matching "延伸".
        // Prefer the cached DURABLE selector: an L3 data-fs tag may not survive
        // Angular re-renders after the model switch.
        const cachedSel = (loadCache().modelButton || {}).sel;
        const verifySel = cachedSel || mbs;
        const verifyDeadline = Date.now() + 5_000;
        let isActive = false;
        while (Date.now() < verifyDeadline) {
            const verifyAria = await readAria(page, verifySel);
            if (isProExtendedAria(verifyAria)) {
                isActive = true;
                break;
            }
            await page.waitForTimeout(250);
        }

        if (isActive) {
            log('gemini: Verified Pro Extended Thinking active.');
            return true;
        }

        // v9 diagnostic: show actual aria-label to detect Google wording changes
        const actualAria = (await readAria(page, verifySel)) || 'UNKNOWN';
        log(`gemini: final mode not confirmed as Pro Extended. Actual aria-label: "${actualAria}"`);
    }
    return false;
}

/**
 * Switch Gemini to the newest full Flash item in the live verified menu
 * plus Extended Thinking. Used as the default model and as the verified
 * fallback when Pro Extended is unavailable. Both independently selected
 * menu rows are required. Never Lite/Pro/Ultra or generic composer Flash.
 *
 * @param {Page} page — Playwright page on gemini.google.com
 * @param {(msg: string) => void} [onLog] — log callback
 * @returns {Promise<boolean>} true only when newest full Flash and Extended Thinking are active
 */
async function ensureFlash(page, onLog) {
    const log = onLog || (() => {});

    // Auto-detect locale if not yet set
    if (!L.locale) {
        const detected = await L.detectLocale(page);
        L.setLocale(detected);
        if (detected) log(`gemini: detected locale ${detected}`);
    }

    await waitForAppReady(page, log);

    // The composer only reports generic "Flash" / "Pro" text, which cannot
    // distinguish a full Flash item from Flash-Lite. Always open the verified
    // model menu and inspect its selected item before accepting the default.
    const peek = await peekModelButtonAria(page);
    if (peek) maybeCorrectLocale(peek.aria, log);

    // Step 1: open the model menu (verify-by-effect discovery)
    const opened = await openModelMenu(page, log);
    if (!opened) {
        log('gemini WARN: Model selector button not found for Flash switch (cache→L1→L2→L3 exhausted).');
        return false;
    }

    if (!(await waitForMenuItemsFilled(page))) {
        log('gemini WARN: Menu items never filled for Flash switch.');
        await page.keyboard.press('Escape').catch(() => {});
        return false;
    }

    // Step 2: Select the newest full Flash item actually in this menu — do
    // NOT fall back to Flash-Lite, Pro, Ultra, or a generic Flash label.
    const menuItems = await readVisibleGeminiModelMenuItems(page);
    const target = pickNewestFullFlash(menuItems);
    const chosenLabel = target ? flashMenuLabel(target) : DEFAULT_FLASH_MODEL.displayName;
    if (!target || !target.dataModeId) {
        log(`gemini WARN: newest full Flash not found in verified model menu.`);
        await page.keyboard.press('Escape');
        return false;
    }

    try {
        await page.locator(`[data-mode-id="${target.dataModeId}"]`).first().click({ timeout: 3000 });
        log(`gemini: selected target model "${chosenLabel}"`);
    } catch {
        log(`gemini WARN: target model "${chosenLabel}" not clickable.`);
        await page.keyboard.press('Escape');
        return false;
    }

    // Step 3: Reopen the verified model menu and ensure Extended Thinking is
    // enabled for the chosen full Flash. Google exposes this as an independent
    // selected menu row; selecting the model alone is not the default contract.
    await page.waitForTimeout(750);
    const thinkingMenu = await openModelMenu(page, log, { budgetMs: 12_000, maxClicks: 3 });
    if (!thinkingMenu) {
        log(`gemini WARN: could not reopen model menu to enable Extended Thinking for "${chosenLabel}".`);
        return false;
    }
    if (!(await ensureExtendedThinkingInOpenMenu(page, log))) {
        await page.keyboard.press('Escape').catch(() => {});
        return false;
    }
    await page.keyboard.press('Escape').catch(() => {});

    // Step 4: Reopen the verified menu and poll the TWO independent selected
    // states. Composer aria "Flash 延伸思考" is useful diagnostics but cannot
    // prove the exact newest full Flash; inspect the checked rows themselves.
    await page.waitForTimeout(750);
    // Reopen verification can spend up to the selector candidate wait budget
    // on a cold Angular toolbar, so do not give it a shorter outer deadline.
    const verifyDeadline = Date.now() + 12_000;
    let lastState = [];
    while (Date.now() < verifyDeadline) {
        const verificationMenu = await openModelMenu(page, log, { budgetMs: 10_000, maxClicks: 3 });
        if (!verificationMenu) break;
        lastState = await readVisibleGeminiMenuState(page);
        await page.keyboard.press('Escape').catch(() => {});
        if (isDefaultFlashExtendedMenuState(lastState)) {
            log(`gemini: verified default state "${chosenLabel}" + Extended Thinking.`);
            return true;
        }
        await page.waitForTimeout(350);
    }

    const selectedText = selectedGeminiModelText(lastState);
    const extendedSelected = lastState.some(item => isSelectedGeminiModelItem(item)
        && isExtendedThinkingText(item && item.text));
    log(`gemini: default state not confirmed. Model="${selectedText || 'UNKNOWN'}", Extended=${extendedSelected}.`);
    return false;
}

module.exports = {
    DEFAULT_FLASH_MODEL,
    isDefaultFlashText,
    isDefaultFlashItem,
    pickNewestFullFlash,
    parseLeadingModelVersion,
    flashMenuLabel,
    isExtendedThinkingText,
    isDefaultFlashExtendedMenuState,
    isGeminiModelMenuItems,
    isProExtendedAria,
    isSelectedGeminiModelItem,
    selectedGeminiModelText,
    ensureProExtended,
    ensureFlash,
    waitForMenuItemsFilled,
    // v10 exports (used by tests; adapter only needs the two ensure* above)
    openModelMenu,
    peekModelButtonAria,
    inferLocaleFromAria,
    _cache: { loadCache, saveCache, dropCache, cachePath },
    locales: L,
};
