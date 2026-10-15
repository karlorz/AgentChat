/**
 * Gemini composer mode — Chat vs Task chips under the input.
 *
 * Custom MCP / @ connectors bind in Task (任務), not Chat (對話). Default
 * AGENTCHAT_GEMINI_COMPOSER_MODE=task; chat is explicit opt-in.
 *
 * Verify-by-effect, same family as geminiModelSwitch: find chips by live
 * locale text, click, then prove the requested chip is the exclusive
 * selected member of the pair. Do not treat a class name as identity;
 * selected-state classes and the group's active index are effect signals.
 */

const L = require('./locales/gemini');

const CHIP_ATTR = 'data-ac-composer-mode';
const NEW_CHAT_RE = /新对话|新對話|New chat/i;

function resolveGeminiComposerMode(raw) {
    const source = arguments.length > 0 ? raw : process.env.AGENTCHAT_GEMINI_COMPOSER_MODE;
    const v = String(source == null ? '' : source).trim().toLowerCase();
    if (!v || v === 'task' || v === 'default') return 'task';
    if (v === 'chat') return 'chat';
    return v;
}

function isKnownComposerMode(mode) {
    return mode === 'task' || mode === 'chat';
}

function normalizeChipText(text) {
    return String(text || '').trim().replace(/\s+/g, ' ');
}

function profileChipLabels(kind) {
    const key = kind === 'task' ? 'composerTask' : 'composerChat';
    const out = new Set();
    for (const p of Object.values(L.PROFILES || {})) {
        if (p && p[key]) out.add(p[key]);
    }
    return out;
}

function classifyComposerChipText(text, chatLabels, taskLabels) {
    const t = normalizeChipText(text);
    if (!t || t.length > 16) return null;
    if (NEW_CHAT_RE.test(t)) return null;
    const lower = t.toLowerCase();
    const chats = chatLabels || profileChipLabels('chat');
    const tasks = taskLabels || profileChipLabels('task');
    for (const label of chats) {
        if (label && String(label).toLowerCase() === lower) return 'chat';
    }
    for (const label of tasks) {
        if (label && String(label).toLowerCase() === lower) return 'task';
    }
    return null;
}

function truthyAria(v) {
    if (v === true) return true;
    const s = String(v == null ? '' : v).trim().toLowerCase();
    return s === 'true' || s === 'page';
}

/**
 * Selected-state proof for one chip. Aria wins; otherwise an ancestor
 * carrying a "selected" class, or the segmented group's active index.
 */
function isComposerChipSelected(chip) {
    if (!chip) return false;
    if (truthyAria(chip.ariaPressed) || truthyAria(chip.ariaSelected)
        || truthyAria(chip.ariaChecked) || truthyAria(chip.ariaCurrent)) {
        return true;
    }
    if (/(?:^|[\s_-])selected(?:[\s_-]|$)/i.test(String(chip.ancestorClass || ''))) {
        return true;
    }
    if (Number.isInteger(chip.groupActiveIndex)
        && Number.isInteger(chip.indexInGroup)
        && chip.groupActiveIndex === chip.indexInGroup) {
        return true;
    }
    return false;
}

function isVerifiedComposerMode(chips, mode) {
    if (!Array.isArray(chips) || !isKnownComposerMode(mode)) return false;
    const chat = chips.find(c => c && c.kind === 'chat');
    const task = chips.find(c => c && c.kind === 'task');
    if (!chat || !task) return false;
    const want = mode === 'task' ? task : chat;
    const other = mode === 'task' ? chat : task;
    return isComposerChipSelected(want) && !isComposerChipSelected(other);
}

/**
 * Browser-side scan. Tags the chosen Chat/Task pair with CHIP_ATTR.
 * Collects selected-state hints; Node applies isComposerChipSelected.
 */
function scanComposerModeChipsInDocument({ chatLabels, taskLabels }) {
    const attr = 'data-ac-composer-mode';
    const newChatRe = /新对话|新對話|New chat/i;
    const chats = (chatLabels || []).map(s => String(s).toLowerCase());
    const tasks = (taskLabels || []).map(s => String(s).toLowerCase());

    const classify = (text) => {
        const t = String(text || '').trim().replace(/\s+/g, ' ');
        if (!t || t.length > 16 || newChatRe.test(t)) return null;
        const lower = t.toLowerCase();
        if (chats.includes(lower)) return 'chat';
        if (tasks.includes(lower)) return 'task';
        return null;
    };

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

    for (const r of roots) {
        try {
            r.querySelectorAll(`[${attr}]`).forEach(el => el.removeAttribute(attr));
        } catch (_) {}
    }

    const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
    };

    const seen = new Set();
    const found = [];
    for (const r of roots) {
        let list = [];
        try {
            list = r.querySelectorAll(
                'button:not([disabled]), [role="button"]:not([disabled]), [role="tab"], [role="radio"]'
            );
        } catch (_) { continue; }
        for (const el of list) {
            if (seen.has(el)) continue;
            seen.add(el);
            const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
            const kind = classify(text);
            if (!kind) continue;
            if (!isVisible(el)) continue;
            const rect = el.getBoundingClientRect();
            found.push({ el, kind, text, top: rect.top, left: rect.left });
        }
    }

    const chatHits = found.filter(x => x.kind === 'chat');
    const taskHits = found.filter(x => x.kind === 'task');
    if (!chatHits.length || !taskHits.length) return [];

    let best = null;
    let bestTop = -Infinity;
    for (const chat of chatHits) {
        for (const task of taskHits) {
            const dy = Math.abs(chat.top - task.top);
            const dx = Math.abs(chat.left - task.left);
            if (dy > 24 || dx > 240 || dx < 8) continue;
            // Prefer the lower pair — composer chips sit under the input,
            // not the sidebar "new chat" control.
            const top = Math.min(chat.top, task.top);
            if (top > bestTop) {
                bestTop = top;
                best = [chat, task];
            }
        }
    }
    if (!best) return [];

    const pair = best.slice().sort((a, b) => a.left - b.left);

    const groupRootFor = (el) => {
        let node = el;
        for (let i = 0; i < 8 && node; i++) {
            try {
                const idx = window.getComputedStyle(node).getPropertyValue('--gem-active-index');
                if (String(idx || '').trim() !== '') return node;
            } catch (_) {}
            node = node.parentElement;
        }
        return null;
    };

    const groupRoot = groupRootFor(pair[0].el) || groupRootFor(pair[1].el);
    let groupActiveIndex = null;
    if (groupRoot) {
        try {
            const raw = window.getComputedStyle(groupRoot).getPropertyValue('--gem-active-index');
            if (raw !== '' && raw != null) {
                const n = parseInt(String(raw).trim(), 10);
                if (Number.isFinite(n)) groupActiveIndex = n;
            }
        } catch (_) {}
    }

    const ancestorClassOf = (el) => {
        const parts = [];
        let node = el;
        for (let i = 0; i < 6 && node; i++) {
            const cls = typeof node.className === 'string'
                ? node.className
                : (node.className && node.className.baseVal) || '';
            if (cls) parts.push(cls);
            node = node.parentElement;
        }
        return parts.join(' ');
    };

    return pair.map((item, indexInGroup) => {
        try { item.el.setAttribute(attr, item.kind); } catch (_) {}
        return {
            kind: item.kind,
            text: item.text,
            indexInGroup,
            groupActiveIndex,
            ancestorClass: ancestorClassOf(item.el),
            ariaPressed: item.el.getAttribute('aria-pressed'),
            ariaSelected: item.el.getAttribute('aria-selected'),
            ariaChecked: item.el.getAttribute('aria-checked'),
            ariaCurrent: item.el.getAttribute('aria-current'),
        };
    });
}

async function readComposerModeChips(page) {
    try {
        const raw = await page.evaluate(scanComposerModeChipsInDocument, {
            chatLabels: [...profileChipLabels('chat')],
            taskLabels: [...profileChipLabels('task')],
        });
        return Array.isArray(raw) ? raw : [];
    } catch (_) {
        return [];
    }
}

async function dumpComposerDiagnostics(page, log) {
    try {
        const info = await page.evaluate(() => {
            const items = [];
            const els = document.querySelectorAll('button:not([disabled]), [role="button"]');
            for (const el of els) {
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) continue;
                const text = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40);
                if (!text || text.length > 24) continue;
                items.push({
                    text,
                    aria: (el.getAttribute('aria-label') || '').slice(0, 40),
                    cls: (typeof el.className === 'string' ? el.className : '').slice(0, 80),
                    top: Math.round(rect.top),
                    left: Math.round(rect.left),
                });
                if (items.length >= 20) break;
            }
            return items;
        });
        log('gemini DIAG: short visible buttons (composer Chat/Task chips not verified):');
        (info || []).forEach((b, i) => {
            log(`  [${i}] top=${b.top} left=${b.left} text="${b.text}" aria="${b.aria}" class="${b.cls}"`);
        });
    } catch (e) {
        log(`gemini DIAG: composer dump failed: ${e.message}`);
    }
}

async function clickComposerChip(page, kind) {
    const sel = `[${CHIP_ATTR}="${kind}"]`;
    try {
        await page.locator(sel).first().click({ timeout: 3000 });
        return true;
    } catch (_) {
        try {
            const ok = await page.evaluate(({ attr, want }) => {
                const el = document.querySelector(`[${attr}="${want}"]`);
                if (!el) return false;
                el.click();
                return true;
            }, { attr: CHIP_ATTR, want: kind });
            return !!ok;
        } catch (_) {
            return false;
        }
    }
}

/**
 * Switch the Gemini composer to Task or Chat. Idempotent when already
 * verified. Returns false when the pair cannot be found or the requested
 * chip is not exclusively selected after click.
 *
 * @param {import('playwright').Page} page
 * @param {(msg: string) => void} [onLog]
 * @param {string} [mode]
 * @param {{budgetMs?: number}} [opts]
 * @returns {Promise<boolean>}
 */
async function ensureComposerMode(page, onLog, mode, opts) {
    const log = onLog || (() => {});
    const want = resolveGeminiComposerMode(mode);
    if (!isKnownComposerMode(want)) {
        log(`gemini WARN: unknown composer mode "${want}" (use task|chat).`);
        return false;
    }

    const deadline = Date.now() + ((opts && opts.budgetMs) || 10_000);
    let last = [];
    let clicked = false;

    while (Date.now() < deadline) {
        last = await readComposerModeChips(page);
        if (isVerifiedComposerMode(last, want)) {
            const label = (last.find(c => c.kind === want) || {}).text || want;
            log(clicked
                ? `gemini: verified composer mode ${want} ("${label}").`
                : `gemini: composer mode already ${want} ("${label}").`);
            return true;
        }
        if (last.some(c => c.kind === 'chat') && last.some(c => c.kind === 'task') && !clicked) {
            log(`gemini: switching composer mode to ${want}`);
            if (!(await clickComposerChip(page, want))) {
                log(`gemini WARN: composer ${want} chip not clickable.`);
                await dumpComposerDiagnostics(page, log);
                return false;
            }
            clicked = true;
            last = await readComposerModeChips(page);
            if (isVerifiedComposerMode(last, want)) {
                const label = (last.find(c => c.kind === want) || {}).text || want;
                log(`gemini: verified composer mode ${want} ("${label}").`);
                return true;
            }
            await page.waitForTimeout(400).catch(() => {});
            continue;
        }
        await page.waitForTimeout(250).catch(() => {});
    }

    const snap = last.map(c => `${c.kind}:${isComposerChipSelected(c) ? 'on' : 'off'}:"${c.text}"`).join(', ')
        || 'none';
    log(`gemini WARN: composer mode ${want} not verified. chips=[${snap}]`);
    await dumpComposerDiagnostics(page, log);
    return false;
}

module.exports = {
    CHIP_ATTR,
    resolveGeminiComposerMode,
    isKnownComposerMode,
    classifyComposerChipText,
    isComposerChipSelected,
    isVerifiedComposerMode,
    readComposerModeChips,
    ensureComposerMode,
    locales: L,
};
