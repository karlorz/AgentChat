/**
 * ChatGPT provider adapter config.
 *
 * Key differences from standard pipeline:
 *   - React contenteditable editor with 3-tier input strategy
 *   - Send-button React state verification (batch updates may delay enable)
 *   - Input strategy: clipboard → simulated PasteEvent → chunked keyboard
 *
 * CHANGELOG (2026-07-03):
 *   - FIX: navPostDelay=4000 — React SPA must mount ProseMirror before editor search;
 *     without delay, only the hidden <textarea class="wcDTda_fallbackTextarea">
 *     exists in initial DOM → findEditableElement falls through to textarea selector
 *     → isVisible times out (element hidden) → ERR_ALL_EXHAUSTED
 *   - FIX: validateEditor now rejects wcDTda_fallbackTextarea class
 *   - FIX: preInputHook waits for visible ProseMirror div as double insurance
 *   - FIX: changed textarea selector to 'textarea:not(.wcDTda_fallbackTextarea)'
 */

const { inputViaKeyboard, COMMON_DISMISS_PATTERNS } = require('../../providerFactory');
const { isDeepResearchActive, DEEP_RESEARCH_TIMEOUT_MS } = require('../chain');

// Safe stderr logger — logs via terminal utility if available
let clog = () => {};
try {
    const { log: _tlog } = require('../../terminal');
    clog = (msg) => { try { _tlog('chatgpt', msg); } catch (_) {} };
} catch (_) { /* logger unavailable — stay silent */ }

const THINK_LABEL_RE = /^(Think|思考)$/i;
const WEB_SEARCH_CHIP_RE = /^(Web search|联网搜索|網頁搜尋|Search the web)$/i;
const WEB_SEARCH_ITEM_RE = /^(Web search|联网搜索|網頁搜尋)\b/i;

function classifyThinkPill({ text, ariaLabel, ariaPressed } = {}) {
    const label = String(text || '').replace(/\s+/g, ' ').trim()
        || String(ariaLabel || '').replace(/\s+/g, ' ').trim();
    if (!THINK_LABEL_RE.test(label)) return { match: false, on: false, clickable: false };
    const pressed = ariaPressed == null ? null : String(ariaPressed);
    if (pressed === 'true') return { match: true, on: true, clickable: false };
    if (pressed === 'false') return { match: true, on: false, clickable: true };
    return { match: true, on: false, clickable: false };
}

function isWebSearchChipEl(el) {
    if (!el) return false;
    if (el.getAttribute && (
        el.getAttribute('data-system-hint-type') === 'search'
        || (el.getAttribute('data-id') === 'search' && el.hasAttribute('data-inline-selection-pill'))
        || /^Web search$/i.test(el.getAttribute('data-keyword') || '')
    )) return true;
    const t = String(el.textContent || el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!WEB_SEARCH_CHIP_RE.test(t) || t.length >= 40) return false;
    const cls = String(el.className || '');
    return /text-token-text-accent|composer-pill|mention/i.test(cls)
        || el.getAttribute('aria-pressed') === 'true';
}

function composerHasWebSearchChip(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return false;
    const root = doc.querySelector('#prompt-textarea') || doc.querySelector('form') || doc.body || doc;
    if (root.querySelector('[data-system-hint-type="search"], [data-id="search"][data-inline-selection-pill]')) {
        return true;
    }
    for (const el of root.querySelectorAll('span, button, [class*="pill"], [class*="mention"]')) {
        if (isWebSearchChipEl(el)) return true;
    }
    return false;
}

function findWebSearchMenuItem(items) {
    for (const it of items || []) {
        const t = String(it.text || '').replace(/\s+/g, ' ').trim();
        if (WEB_SEARCH_ITEM_RE.test(t)) return it;
    }
    return null;
}

async function mouseClickCenter(page, box) {
    if (!box || !page.mouse) return false;
    await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
    return true;
}

async function placeCaretAfterComposerChips(page) {
    try {
        await page.evaluate(() => {
            const editor = document.querySelector('#prompt-textarea');
            if (!editor) return;
            editor.focus();
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(editor);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        return true;
    } catch (_) {
        return false;
    }
}

async function ensureChatgptThinkOn(page) {
    if (process.env.AGENTCHAT_CHATGPT_NO_THINK === '1') return 'skipped';
    try {
        const state = await page.evaluate(() => {
            const pills = [...document.querySelectorAll('button.__composer-pill')];
            const btn = pills.find(el => /^(Think|思考)$/i.test((el.innerText || '').trim()));
            if (!btn) return { found: false };
            const r = btn.getBoundingClientRect();
            return {
                found: true,
                ariaPressed: btn.getAttribute('aria-pressed'),
                box: { x: r.x, y: r.y, w: r.width, h: r.height },
            };
        });
        if (!state || !state.found) return 'missing';
        const cls = classifyThinkPill({ text: 'Think', ariaPressed: state.ariaPressed });
        if (cls.on) return 'already-on';
        if (!cls.clickable) return 'unknown';
        // Real pointer click: el.click() / locator.click() often leave
        // aria-pressed=false on a fresh chatgpt.com composer (2026-09-08).
        const clicked = await mouseClickCenter(page, state.box);
        if (!clicked) return 'unknown';
        if (page.locator) {
            try {
                await page.locator('button.__composer-pill[aria-pressed="true"]')
                    .filter({ hasText: /^(Think|思考)$/i })
                    .first().waitFor({ timeout: 1000 });
                return 'clicked';
            } catch (_) { /* fall through to evaluate */ }
        }
        const pressed = await page.evaluate(() => {
            const btn = [...document.querySelectorAll('button.__composer-pill')]
                .find(el => /^(Think|思考)$/i.test((el.innerText || '').trim()));
            return btn && btn.getAttribute('aria-pressed');
        });
        return pressed === 'true' ? 'clicked' : 'missing';
    } catch (_) {
        return 'error';
    }
}

async function chipInComposer(page) {
    return page.evaluate(() => {
        const root = document.querySelector('#prompt-textarea')
            || document.querySelector('form') || document.body;
        return !!root.querySelector('[data-system-hint-type="search"], [data-id="search"][data-inline-selection-pill]');
    });
}

async function pickWebSearchMenuRow(page) {
    if (!page.locator) return false;
    try {
        await page.locator('.popover').getByText(/Find real-time news|查找实时新闻|找即時新聞/i)
            .first().click({ timeout: 3000 });
        return true;
    } catch (_) {
        return false;
    }
}

async function waitForChip(page) {
    if (page.locator) {
        try {
            await page.locator('#prompt-textarea [data-system-hint-type="search"], #prompt-textarea [data-id="search"][data-inline-selection-pill]')
                .first().waitFor({ state: 'attached', timeout: 2000 });
            return true;
        } catch (_) {
            return false;
        }
    }
    return chipInComposer(page);
}

async function ensureChatgptWebSearchOn(page) {
    if (process.env.AGENTCHAT_CHATGPT_NO_WEB_SEARCH === '1') return 'skipped';
    try {
        if (await chipInComposer(page)) return 'already-on';

        // One insert only: type @ and pick Web search. Do not also click +
        // (that duplicates the mention as typed "Web search" text).
        if (page.locator) {
            await page.locator('#prompt-textarea[contenteditable="true"]').first()
                .click({ timeout: 5000 }).catch(() => {});
        }
        if (page.keyboard && page.keyboard.type) {
            await page.keyboard.type('@');
        } else if (page.keyboard && page.keyboard.insertText) {
            await page.keyboard.insertText('@');
        } else {
            return 'missing';
        }
        await pickWebSearchMenuRow(page);
        if (await waitForChip(page)) return 'clicked';
        if (page.keyboard && page.keyboard.press) {
            await page.keyboard.press('Escape').catch(() => {});
            await page.keyboard.press('Backspace').catch(() => {});
        }
        return 'missing';
    } catch (_) {
        return 'error';
    }
}

function isChatgptDeepResearchActive() {
    return isDeepResearchActive('chatgpt');
}

async function isChatgptDeepResearchOn(page) {
    return page.evaluate(() => {
        const root = document.querySelector('#prompt-textarea')
            || document.querySelector('form') || document.body;
        // Check for DR chip/pill or inline selection pill
        const chip = root.querySelector(
            '[data-system-hint-type*="research" i], [data-system-hint-type*="deep" i], ' +
            '[data-id*="research" i], [data-id*="deep" i], ' +
            '[data-inline-selection-pill][data-keyword*="research" i], [data-inline-selection-pill]'
        );
        if (chip && (/deep\s*research|深度研究/i.test(chip.textContent || chip.getAttribute('data-system-hint-type') || chip.getAttribute('data-id') || chip.getAttribute('data-keyword') || ''))) return true;
        // Check aria-pressed or data-state on composer buttons/pills
        for (const btn of root.querySelectorAll('button, [role="button"], [class*="pill"]')) {
            const t = (btn.innerText || btn.textContent || '').trim();
            if (/Deep\s*research|深度研究/i.test(t)) {
                if (btn.getAttribute('aria-pressed') === 'true' || btn.getAttribute('data-state') === 'checked' || btn.getAttribute('data-state') === 'active') {
                    return true;
                }
            }
        }
        return false;
    });
}

async function findAndClickPlusButton(page) {
    if (page.locator) {
        // One comma-joined probe instead of 5 sequential 500ms-timeout checks.
        const loc = page.locator(
            'button[aria-label*="+" i], button[aria-label*="attach" i], button[aria-label*="add" i], button[data-testid*="plus" i], button[data-testid*="attach" i]'
        ).first();
        try {
            if (await loc.isVisible({ timeout: 800 })) {
                await loc.click({ timeout: 1000 });
                return true;
            }
        } catch (_) {}
    }
    // Fall back to scanning composer buttons
    return page.evaluate(() => {
        const root = document.querySelector('form') || document.querySelector('#prompt-textarea')?.closest('div') || document.body;
        const btns = [...root.querySelectorAll('button')];
        const plusBtn = btns.find(b => {
            const label = b.getAttribute('aria-label') || '';
            const text = (b.innerText || b.textContent || '').trim();
            return /\+|attach|add/i.test(label) || text === '+';
        });
        if (plusBtn) {
            plusBtn.click();
            return true;
        }
        return false;
    });
}

async function ensureChatgptDeepResearchOn(page) {
    if (!isChatgptDeepResearchActive()) return 'skipped';
    try {
        if (await isChatgptDeepResearchOn(page)) return 'already-on';

        // Open composer "+" menu
        const opened = await findAndClickPlusButton(page);
        if (!opened) {
            clog('⚠ Plus button not found for Deep research');
            return 'missing';
        }

        await page.waitForTimeout?.(500);

        // Find and click the menu row matching /Deep\s*research/i
        let clickedRow = false;
        if (page.locator) {
            try {
                const row = page.locator('[role="menuitem"], [role="option"], .popover div, [class*="menu-item"], div')
                    .filter({ hasText: /Deep\s*research|深度研究/i })
                    .first();
                if (await row.isVisible({ timeout: 2000 })) {
                    await row.click({ timeout: 2000 });
                    clickedRow = true;
                }
            } catch (_) {}
        }

        if (!clickedRow) {
            clickedRow = await page.evaluate(() => {
                const elements = [...document.querySelectorAll('[role="menuitem"], [role="option"], .popover [role="button"], [class*="menu-item"], .popover div')];
                const row = elements.find(el => {
                    // Avoid matching a parent container that contains multiple items
                    if (el.children && el.children.length > 2) return false;
                    const text = (el.innerText || el.textContent || '').trim();
                    return /Deep\s*research|深度研究/i.test(text);
                });
                if (row) {
                    if (typeof row.click === 'function') row.click();
                    try {
                        const evt = typeof MouseEvent !== 'undefined' ? new MouseEvent('click', { bubbles: true, cancelable: true }) : (typeof window !== 'undefined' && window.MouseEvent ? new window.MouseEvent('click', { bubbles: true, cancelable: true }) : null);
                        if (evt) row.dispatchEvent(evt);
                    } catch (_) {}
                    return true;
                }
                return false;
            });
        }

        if (!clickedRow) {
            clog('⚠ Deep research menu row not found in plus menu');
            return 'missing';
        }

        await page.waitForTimeout?.(500);

        // Verify-by-effect: after the click the composer shows a deep-research active state
        const active = await isChatgptDeepResearchOn(page);
        if (active) return 'clicked';

        // If no state is provable, log via logger and continue (fail-soft)
        clog('Deep research row clicked but active state ambiguous — proceeding with default');
        return 'ambiguous';
    } catch (err) {
        clog(`ensureChatgptDeepResearchOn error: ${err.message}`);
        return 'error';
    }
}

const adapter = {
    key: 'chatgpt',
    url: 'https://chatgpt.com/',
    authDomains: ['auth.openai.com', 'chat.openai.com/auth'],
    // v35: Deep research runs 5-30 min. The 180s default per-provider budget
    // SIGKILLs the call. Raised to the shared DR budget (30 min) when opted in.
    providerTimeoutOverride: () => isChatgptDeepResearchActive() ? DEEP_RESEARCH_TIMEOUT_MS : undefined,
    navPostDelay: 4000, // ⚡ React SPA mounts ProseMirror ~2-3s after domcontentloaded
    quotaPatterns: [
        /reached.*(?:limit|quota|cap)/i,
        /upgrade\s*(?:to|your)\s*plus/i,
        /free\s*(?:plan|tier)\s*limit/i,
        /usage\s*(?:limit|cap|exceeded)/i,
        /you'?ve\s*(?:reached|hit).*(?:limit|cap)/i,
        /请.*升级/i,
        /额度.*(?:用|已).*尽/i,
    ],
    dismissPatterns: [
        ...COMMON_DISMISS_PATTERNS,
        /welcome\s*back/i,
    ],
    editorSelectors: [
        '#prompt-textarea',                          // ProseMirror div (visible, React-mounted)
        '[contenteditable="true"][role="textbox"]',  // generic ProseMirror
        'div[contenteditable="true"]:not(.ProseMirror-hide)', // any visible editable div
        'textarea:not(.wcDTda_fallbackTextarea)',    // textarea but NOT the hidden fallback
    ],
    validateEditor: async (loc) => {
        return loc.evaluate(el => {
            // Reject the hidden ProseMirror fallback textarea
            if (el.tagName === 'TEXTAREA' && el.classList.contains('wcDTda_fallbackTextarea')) {
                return false;
            }
            if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                return !el.hasAttribute('readonly') && !el.hasAttribute('disabled');
            }
            return el.getAttribute('contenteditable') !== 'false'
                && !el.hasAttribute('readonly')
                && !el.hasAttribute('disabled');
        });
    },
    sendSelectors: [
        'button[data-testid="send-button"]',         // primary — verified 2026-07-03
        'button[aria-label="发送提示"]',              // Chinese locale variant
        'button[aria-label="Send prompt"]',           // English locale variant
        'button[aria-label="Send"]',                  // short English variant
        // P1-11: removed 'button svg' — matches ANY button containing an SVG
        // (new-chat, voice-input, attach-file, etc.), so misclick risk >> benefit.
        // sendFallback: 'Enter' already covers the case where no selector matches.
    ],
    sendFallback: 'Enter',
    stopSelectors: [
        'button[data-testid="stop-button"]',
        'button[aria-label="Stop"]',
    ],
    responseSelectors: [
        '.markdown',
        '[data-message-author-role="assistant"]',
        '.agent-turn',
        '[class*="response"]',
    ],
    // v13: DALL·E mounts the generated <img> as a SIBLING of the .markdown
    // text container inside the assistant turn — scanning only the matched
    // responseEl misses it. Widen the image scan to the enclosing turn.
    imageScopeSelector: '[data-message-author-role="assistant"]',
    stabilityWindow: 10_000,
    minResponseLength: 5,

    // ── Pre-input hook: wait for ProseMirror editor to be ready ──
    // The navPostDelay handles the common case, but this is the safety net
    // for slow network / server-rendered pages that take longer to hydrate.
    preInputHook: async (page, C) => {
        // Wait for the ProseMirror editor div to be visible and interactive
        // (not the hidden fallback textarea that exists in initial HTML)
        try {
            await page.locator('#prompt-textarea[contenteditable="true"]').first()
                .waitFor({ state: 'visible', timeout: 8000 });
        } catch (_) {
            // If ProseMirror didn't appear, try waiting for any visible textbox
            await page.waitForTimeout(3000);
        }
    },

    // Free ChatGPT: @Web search mention, then prompt, then Think.
    // When deep research is opted in, ensure DR first and skip web search chip.
    // Keyboard append keeps the mention; paste-replace would wipe it.
    input: async (page, editor, prompt) => {
        if (isChatgptDeepResearchActive()) {
            await ensureChatgptDeepResearchOn(page);
        } else {
            await ensureChatgptWebSearchOn(page);
        }
        await placeCaretAfterComposerChips(page);
        const text = /^\s/.test(prompt) ? prompt : ' ' + prompt;
        await inputViaKeyboard(page, editor, text, { chunkSize: 150, yieldMs: 40 });
        await ensureChatgptThinkOn(page);

        // Verify Send button — React batches state updates asynchronously
        const sendBtn = page.locator('button[data-testid="send-button"]').first();
        let sendEnabled = false;
        try {
            sendEnabled = await sendBtn.evaluate(el =>
                !el.hasAttribute('disabled')
                && el.getAttribute('aria-disabled') !== 'true'
                && !el.classList.contains('disabled')
            );
        } catch (_) { /* button may not exist yet */ }

        if (!sendEnabled) {
            // Trigger React onChange via InputEvent to enable the send button
            await editor.evaluate(node => {
                node.dispatchEvent(new InputEvent('input', {
                    bubbles: true, composed: true,
                    inputType: 'insertText', data: ' ',
                }));
            });
            await page.waitForTimeout(600);
        }

        return true;
    },
};

adapter.classifyThinkPill = classifyThinkPill;
adapter.composerHasWebSearchChip = composerHasWebSearchChip;
adapter.findWebSearchMenuItem = findWebSearchMenuItem;
adapter._ensureChatgptThinkOn = ensureChatgptThinkOn;
adapter._ensureChatgptWebSearchOn = ensureChatgptWebSearchOn;
adapter._ensureChatgptDeepResearchOn = ensureChatgptDeepResearchOn;
adapter._isChatgptDeepResearchActive = isChatgptDeepResearchActive;
adapter._placeCaretAfterComposerChips = placeCaretAfterComposerChips;

module.exports = adapter;
