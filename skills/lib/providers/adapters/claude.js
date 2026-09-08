/**
 * Claude provider adapter config.
 *
 * Key differences from standard pipeline:
 *   - ProseMirror contenteditable editor (validateEditor ensures it's actually editable)
 *   - Stop button may not appear for fast responses — factory handles this gracefully
 *   - postResponseHook strips "Thinking" placeholder + embedded search-result blocks
 *   - preInputHook manages Web search, Thinking effort, and Deep Research toggles
 */

const { COMMON_DISMISS_PATTERNS } = require('../../providerFactory');
const { isDeepResearchActive, DEEP_RESEARCH_TIMEOUT_MS } = require('../chain');

// Safe stderr logger — logs via terminal utility if available
let clog = () => {};
try {
    const { log: _tlog } = require('../../terminal');
    clog = (msg) => { try { _tlog('claude', msg); } catch (_) {} };
} catch (_) { /* logger unavailable — stay silent */ }

/**
 * Base UI portal cleanup helper.
 * While any menu is open, `#portal-root [data-base-ui-inert]` exists and intercepts
 * pointer events. Press Escape and wait until that selector is gone (retry up to 3×).
 */
async function closeMenusAndWait(page) {
    for (let i = 0; i < 3; i++) {
        const inertLoc = page.locator ? page.locator('#portal-root [data-base-ui-inert]').first() : null;
        let isInert = false;
        if (inertLoc && inertLoc.isVisible) {
            isInert = await inertLoc.isVisible().catch(() => false);
        } else if (page.evaluate) {
            isInert = await page.evaluate(() => {
                return !!document.querySelector('#portal-root [data-base-ui-inert]');
            }).catch(() => false);
        }
        if (!isInert && i > 0) break;
        if (page.keyboard && page.keyboard.press) {
            await page.keyboard.press('Escape').catch(() => {});
        }
        if (page.waitForTimeout) await page.waitForTimeout(100);
        // If not inert now, we are done
        let stillInert = false;
        if (inertLoc && inertLoc.isVisible) {
            stillInert = await inertLoc.isVisible().catch(() => false);
        } else if (page.evaluate) {
            stillInert = await page.evaluate(() => {
                return !!document.querySelector('#portal-root [data-base-ui-inert]');
            }).catch(() => false);
        }
        if (!stillInert) break;
    }
}

/**
 * Wait-for-visibility helper. Playwright's locator.isVisible() is an IMMEDIATE
 * check — its {timeout} option is ignored — so it must never be used to wait for
 * menu items that animate in. Uses waitFor(state:'visible') when available,
 * otherwise polls isVisible (mock pages in unit tests).
 */
async function waitVisible(loc, ms) {
    if (loc && loc.waitFor) {
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
 * Dismiss a blocking Base UI portal dialog (e.g. "Review updates to Claude's memory").
 * Such dialogs render `#portal-root [data-base-ui-inert]`, which intercepts ALL pointer
 * events — including the composer's. Escape does NOT close them; only a safe,
 * non-committing button ("Not now" / "Got it" / "Dismiss") is clicked — never
 * preference-committing ones like "Save preferences" or "Accept".
 */
async function dismissClaudeBlockingDialog(page) {
    try {
        const inertLoc = page.locator('#portal-root [data-base-ui-inert]').first();
        if (!(await inertLoc.isVisible().catch(() => false))) return 'absent';
        const dialog = page.locator('#portal-root [role="dialog"]').last();
        if (!(await dialog.isVisible().catch(() => false))) return 'absent';
        const safeBtn = dialog.locator('button')
            .filter({ hasText: /^(Not now|Got it|Dismiss)$/i }).first();
        if (await waitVisible(safeBtn, 1000)) {
            await safeBtn.click({ timeout: 2500 });
            clog('dismissed blocking portal dialog');
        } else {
            clog('blocking portal dialog has no safe dismiss button');
        }
        await closeMenusAndWait(page);
        return 'dismissed';
    } catch (e) {
        clog(`dismissClaudeBlockingDialog error: ${e.message}`);
        return 'error';
    }
}

/**
 * 1. ensureClaudeWebSearchOn(page) — default ON, opt-out AGENTCHAT_CLAUDE_NO_WEB_SEARCH=1.
 * Open + menu via button[aria-label*="Add files" i]; find menuitemcheckbox matching /^Web search/i;
 * read aria-checked: if 'true' -> already-on (close menu, done); if 'false' -> click,
 * verify aria-checked flips to 'true' (reopen menu to read if it closed);
 * if row missing -> log + 'missing'. Finish with closeMenusAndWait.
 */
async function ensureClaudeWebSearchOn(page) {
    if (process.env.AGENTCHAT_CLAUDE_NO_WEB_SEARCH === '1') {
        clog('Web search opt-out (AGENTCHAT_CLAUDE_NO_WEB_SEARCH=1)');
        return 'skipped';
    }
    try {
        const plusBtn = page.locator('button[aria-label*="Add files" i]').first();
        const hasPlus = await waitVisible(plusBtn, 2000);
        if (!hasPlus) {
            clog('composer "+" button not found');
            return 'missing';
        }
        await plusBtn.click({ timeout: 2500 });
        if (page.waitForTimeout) await page.waitForTimeout(150);

        const searchItem = page.locator('[role="menuitemcheckbox"]')
            .filter({ hasText: /Web search/i }).first();
        const hasSearch = await waitVisible(searchItem, 2000);
        if (!hasSearch) {
            clog('Web search menu item not found');
            await closeMenusAndWait(page);
            return 'missing';
        }

        const checked = await searchItem.getAttribute('aria-checked');
        if (checked === 'true') {
            clog('Web search already active');
            await closeMenusAndWait(page);
            return 'already-on';
        }

        // Toggle on
        await searchItem.click({ timeout: 2500 });
        if (page.waitForTimeout) await page.waitForTimeout(150);

        // Verify flip: Base UI menus may close on toggle or stay open
        let nowChecked = await searchItem.getAttribute('aria-checked').catch(() => null);
        if (nowChecked !== 'true') {
            // Re-open if closed to verify
            const stillVisible = await searchItem.isVisible().catch(() => false);
            if (!stillVisible) {
                await plusBtn.click({ timeout: 2500 }).catch(() => {});
                if (page.waitForTimeout) await page.waitForTimeout(150);
                nowChecked = await searchItem.getAttribute('aria-checked').catch(() => null);
            }
        }

        await closeMenusAndWait(page);
        if (nowChecked === 'true') {
            clog('Web search activated');
            return 'clicked';
        }
        clog('failed to verify Web search activation');
        return 'failed';
    } catch (e) {
        clog(`ensureClaudeWebSearchOn error: ${e.message}`);
        await closeMenusAndWait(page).catch(() => {});
        return 'error';
    }
}

/**
 * Helper to find and open the model selector button (e.g. Sonnet 5).
 */
async function openClaudeModelMenu(page) {
    const modelBtn = page.locator('button')
        .filter({ hasText: /Sonnet|Opus|Haiku/i }).last();
    const hasBtn = await waitVisible(modelBtn, 2000);
    if (!hasBtn) {
        return null;
    }
    await modelBtn.click({ timeout: 2500 });
    if (page.waitForTimeout) await page.waitForTimeout(150);
    return modelBtn;
}

/**
 * Helper to open the Effort submenu from an already opened model menu.
 * Hovering (or clicking) the "Effort" row opens the second menu.
 */
async function openClaudeEffortSubmenu(page) {
    const effortItem = page.locator('[role="menuitem"]')
        .filter({ hasText: /Effort/i }).first();
    const hasEffort = await waitVisible(effortItem, 2000);
    if (!hasEffort) {
        return null;
    }
    if (effortItem.hover) {
        await effortItem.hover({ timeout: 2000 }).catch(async () => {
            await effortItem.click({ timeout: 2000 });
        });
    } else {
        await effortItem.click({ timeout: 2000 });
    }
    if (page.waitForTimeout) await page.waitForTimeout(150);
    return effortItem;
}

/**
 * 2. ensureClaudeThinkingOn(page) — default ON, opt-out AGENTCHAT_CLAUDE_NO_THINK=1.
 * Open model selector; hover the /^Effort/ row to open the submenu (if hover fails, click it);
 * find menuitemcheckbox matching /^Thinking\b/i; if aria-checked 'true' -> already-on;
 * if 'false' -> click + verify; missing -> log + 'missing'. Finish with closeMenusAndWait.
 *
 * (Can accept options: { keepOpen: true } if called in batch with ensureClaudeEffort)
 */
async function ensureClaudeThinkingOn(page, options = {}) {
    if (process.env.AGENTCHAT_CLAUDE_NO_THINK === '1') {
        clog('Thinking opt-out (AGENTCHAT_CLAUDE_NO_THINK=1)');
        return 'skipped';
    }
    try {
        const modelBtn = await openClaudeModelMenu(page);
        if (!modelBtn) {
            clog('model selector button not found');
            return 'missing';
        }
        const effortItem = await openClaudeEffortSubmenu(page);
        if (!effortItem) {
            clog('Effort menu item not found');
            await closeMenusAndWait(page);
            return 'missing';
        }

        const thinkingItem = page.locator('[role="menuitemcheckbox"]')
            .filter({ hasText: /Thinking/i }).first();
        const hasThinking = await waitVisible(thinkingItem, 2000);
        if (!hasThinking) {
            clog('Thinking menu item not found');
            await closeMenusAndWait(page);
            return 'missing';
        }

        const checked = await thinkingItem.getAttribute('aria-checked');
        if (checked === 'true') {
            clog('Thinking already active');
            if (!options.keepOpen) await closeMenusAndWait(page);
            return 'already-on';
        }

        await thinkingItem.click({ timeout: 2500 });
        if (page.waitForTimeout) await page.waitForTimeout(150);

        let nowChecked = await thinkingItem.getAttribute('aria-checked').catch(() => null);
        if (nowChecked !== 'true') {
            const stillVisible = await thinkingItem.isVisible().catch(() => false);
            if (!stillVisible) {
                await openClaudeModelMenu(page);
                await openClaudeEffortSubmenu(page);
                nowChecked = await thinkingItem.getAttribute('aria-checked').catch(() => null);
            }
        }

        if (!options.keepOpen) await closeMenusAndWait(page);
        if (nowChecked === 'true') {
            clog('Thinking activated');
            return 'clicked';
        }
        clog('failed to verify Thinking activation');
        return 'failed';
    } catch (e) {
        clog(`ensureClaudeThinkingOn error: ${e.message}`);
        await closeMenusAndWait(page).catch(() => {});
        return 'error';
    }
}

/**
 * 3. ensureClaudeEffort(page) — OPT-IN only: AGENTCHAT_CLAUDE_EFFORT=low|medium|high (case-insensitive).
 * In the same Effort submenu click the matching menuitemradio (word-boundary match; NEVER Extra/Max).
 * Default (env unset): leave the page setting untouched.
 *
 * (Can accept options: { keepOpen: true })
 */
async function ensureClaudeEffort(page, options = {}) {
    const rawEffort = (process.env.AGENTCHAT_CLAUDE_EFFORT || '').trim().toLowerCase();
    if (!rawEffort || !['low', 'medium', 'high'].includes(rawEffort)) {
        return 'skipped';
    }
    try {
        const modelBtn = await openClaudeModelMenu(page);
        if (!modelBtn) {
            clog('model selector button not found');
            return 'missing';
        }
        const effortItem = await openClaudeEffortSubmenu(page);
        if (!effortItem) {
            clog('Effort menu item not found');
            await closeMenusAndWait(page);
            return 'missing';
        }

        // NOTE: no \b word boundaries — Playwright's hasText regex serialization breaks on \b.
        // Unanchored is collision-safe here: the Effort submenu rows are Low/Medium/High/Extra/Max.
        const targetPattern = new RegExp(rawEffort, 'i');
        const targetRadio = page.locator('[role="menuitemradio"]')
            .filter({ hasText: targetPattern }).first();
        const hasTarget = await waitVisible(targetRadio, 2000);
        if (!hasTarget) {
            clog(`Effort radio for ${rawEffort} not found`);
            await closeMenusAndWait(page);
            return 'missing';
        }

        const checked = await targetRadio.getAttribute('aria-checked');
        if (checked === 'true') {
            clog(`Effort already ${rawEffort}`);
            if (!options.keepOpen) await closeMenusAndWait(page);
            return 'already-on';
        }

        await targetRadio.click({ timeout: 2500 });
        if (page.waitForTimeout) await page.waitForTimeout(150);

        if (!options.keepOpen) await closeMenusAndWait(page);
        clog(`Effort set to ${rawEffort}`);
        return 'clicked';
    } catch (e) {
        clog(`ensureClaudeEffort error: ${e.message}`);
        await closeMenusAndWait(page).catch(() => {});
        return 'error';
    }
}

/**
 * 4. ensureClaudeResearchOn(page) — deep research, opt-in only: isDeepResearchActive('claude')
 * Look for a menuitemcheckbox/[role="menuitem"] matching /^Research\b|Deep\s*Research/i in the + menu;
 * absent on free plan -> log 'missing' and continue (fail-soft).
 */
async function ensureClaudeResearchOn(page) {
    if (!isDeepResearchActive('claude')) {
        return 'skipped';
    }
    try {
        const plusBtn = page.locator('button[aria-label*="Add files" i]').first();
        const hasPlus = await waitVisible(plusBtn, 2000);
        if (!hasPlus) {
            clog('composer "+" button not found');
            return 'missing';
        }
        await plusBtn.click({ timeout: 2500 });
        if (page.waitForTimeout) await page.waitForTimeout(150);

        const researchItem = page.locator('[role="menuitemcheckbox"], [role="menuitem"]')
            .filter({ hasText: /Research|Deep\s*Research/i }).first();
        const hasResearch = await waitVisible(researchItem, 2000);
        if (!hasResearch) {
            clog('Deep Research menu item not found');
            await closeMenusAndWait(page);
            return 'missing';
        }

        const checked = await researchItem.getAttribute('aria-checked');
        if (checked === 'true') {
            clog('Deep Research already active');
            await closeMenusAndWait(page);
            return 'already-on';
        }

        await researchItem.click({ timeout: 2500 });
        if (page.waitForTimeout) await page.waitForTimeout(150);

        await closeMenusAndWait(page);
        clog('Deep Research activated');
        return 'clicked';
    } catch (e) {
        clog(`ensureClaudeResearchOn error: ${e.message}`);
        await closeMenusAndWait(page).catch(() => {});
        return 'error';
    }
}

const adapter = {
    key: 'claude',
    url: 'https://claude.ai/',
    authDomains: ['claude.ai/login', 'auth.anthropic.com'],
    providerTimeoutOverride: () => (isDeepResearchActive('claude') ? DEEP_RESEARCH_TIMEOUT_MS : undefined),
    quotaPatterns: [
        /rate\s*limit\s*(?:exceeded|reached)/i,
        /out\s*of\s*messages/i,
        /messages?\s*remaining[:\s]*0/i,
        /usage\s*limit/i,
        // BUGFIX: bare /please\s*wait/i matched generic "Please wait..." loading
        // text and misclassified a perfectly available Claude as quota-exhausted.
        // Only treat it as quota when tied to a rate-limit context.
        /please\s*wait\s*(?:\d+|a few|until|before\s+sending)/i,
    ],
    dismissPatterns: [
        ...COMMON_DISMISS_PATTERNS,
        /announcement/i,
    ],
    editorSelectors: [
        // v11 ORDER FIX: the page-global '[contenteditable="true"]' was FIRST,
        // so .first() could bind a rename field / dialog editable instead of
        // the composer whenever one existed. Specific → generic; the generic
        // entry stays as the last-resort tail.
        '.ProseMirror',
        'div[role="textbox"]',
        '[contenteditable="true"]',
    ],
    validateEditor: async (loc) => {
        return loc.evaluate(el =>
            el.getAttribute('contenteditable') !== 'false'
            && !el.hasAttribute('readonly')
            && !el.hasAttribute('disabled')
        );
    },
    sendSelectors: [
        'button[aria-label="Send message"]',
        'button[aria-label="Send Message"]',
        'button[aria-label="Send"]',
    ],
    sendFallback: 'Enter',
    stopSelectors: [
        // Only two genuinely distinct selectors; the wildcard `*="Stop"` already
        // covers both exact aria-label variants.  Dedup saves up to 6s of serial
        // probe time in waitForCompletion phase 1 (2 redundant selectors × 3s
        // STOP_PROBE_TIMEOUT_MS each).
        'button[aria-label*="Stop"]',
        '[data-testid="stop-button"]',
    ],
    responseSelectors: [
        '.prose',
        '[class*="font-claude-message"]',
        '[class*="msg-content"]',
        '[class*="msg-assistant"]',
        '[class*="message"]',
    ],
    stabilityWindow: 10_000,
    minResponseLength: 5,

    preInputHook: async (page) => {
        // Step 0: dismiss blocking portal dialogs (memory review etc.) — they
        // intercept every pointer event, so nothing else can work while one is up.
        try {
            await dismissClaudeBlockingDialog(page);
        } catch (e) {
            clog(`dismissClaudeBlockingDialog error: ${e.message}`);
        }

        // Step 1: Web search (default ON, opt-out AGENTCHAT_CLAUDE_NO_WEB_SEARCH=1)
        try {
            await ensureClaudeWebSearchOn(page);
        } catch (e) {
            clog(`ensureClaudeWebSearchOn error: ${e.message}`);
        }

        // Steps 2 & 3: Model selector menu -> Thinking effort & Effort level
        // (Open once or sequentially, closing menus cleanly)
        try {
            await ensureClaudeThinkingOn(page);
        } catch (e) {
            clog(`ensureClaudeThinkingOn error: ${e.message}`);
        }

        try {
            await ensureClaudeEffort(page);
        } catch (e) {
            clog(`ensureClaudeEffort error: ${e.message}`);
        }

        // Step 4: Deep research (opt-in only: AGENTCHAT_CLAUDE_DEEP_RESEARCH=1 or AGENTCHAT_DEEP_RESEARCH=1)
        try {
            await ensureClaudeResearchOn(page);
        } catch (e) {
            clog(`ensureClaudeResearchOn error: ${e.message}`);
        }
    },

    // ── Post-processing: strip "Thinking" placeholder + search-result blocks ──
    postResponseHook: async (_page, text) => {
        let cleaned = text.replace(
            /^(Thinking|Analyzing|Reasoning|思考中|分析中)\.{0,3}\s*/gim, ''
        ).trim();

        // Strip embedded search-result blocks
        const SEARCH_HEADER_RE = /\n\d+\s+results?\s*\n/i;
        const searchIdx = cleaned.search(SEARCH_HEADER_RE);
        if (searchIdx > -1) {
            const afterResults = cleaned.substring(searchIdx).search(/\n\s*\n\S/);
            if (afterResults > -1) {
                const cutPoint = searchIdx + afterResults + 1;
                const kept = cleaned.substring(cutPoint).trim();
                if (kept.length > 20) cleaned = kept;
            }
        }

        // Reject placeholder-only responses (returns empty → fails minResponseLength downstream).
        // BUGFIX: previously also rejected anything under 30 chars via `check.length < 30`,
        // which contradicted this adapter's own `minResponseLength: 5` and silently discarded
        // legitimate short answers (e.g. a one-word confirmation or a bare number). The
        // anchored placeholder patterns below already correctly identify placeholder-only
        // text (they require the ENTIRE trimmed response to match), so the extra length
        // gate was redundant as well as wrong.
        const placeholderPatterns = [
            /^Thinking\.{0,3}\s*$/i, /^Analyzing\.{0,3}\s*$/i,
            /^Reasoning\.{0,3}\s*$/i, /^思考中\.{0,3}\s*$/i,
            /^分析中\.{0,3}\s*$/i,
        ];
        const check = cleaned.replace(/[\s\n]+/g, ' ').trim();
        if (placeholderPatterns.some(p => p.test(check))) {
            return '';
        }
        return cleaned;
    },
};

adapter._closeMenusAndWait = closeMenusAndWait;
adapter._dismissClaudeBlockingDialog = dismissClaudeBlockingDialog;
adapter._ensureClaudeWebSearchOn = ensureClaudeWebSearchOn;
adapter._ensureClaudeThinkingOn = ensureClaudeThinkingOn;
adapter._ensureClaudeEffort = ensureClaudeEffort;
adapter._ensureClaudeResearchOn = ensureClaudeResearchOn;

module.exports = adapter;
