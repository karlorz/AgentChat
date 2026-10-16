/**
 * Gemini MCP name layers.
 *
 * Task-mode custom MCP has two layers that ChatGPT/Gemini tables mix:
 *   connector     — top-level @ chip (WebCodex Local Projects, SkillWiki)
 *   inner_project — server/project inside a connector (GrokSearch, trends)
 *
 * Classify text only. Do not treat an inner project as an @ connector.
 * Task-mode Gemini also requires the `@Webcodex Local Projects` mention
 * chip; `ensureGeminiWebcodexMention` types `@Webcodex` and picks only
 * that row.
 */

'use strict';

const CONNECTOR_ALIASES = Object.freeze([
    { id: 'webcodex-local-projects', re: /webcodex(?:\s+local\s+projects)?/i },
    { id: 'skillwiki', re: /skillwiki/i },
]);

const INNER_PROJECT_ALIASES = Object.freeze([
    { id: 'groksearch', re: /^grok[\s_-]*search$/i },
    { id: 'trends', re: /^trends$/i },
]);

function normalizeMcpName(text) {
    return String(text || '').trim().replace(/\s+/g, ' ');
}

function classifyGeminiMcpName(text) {
    const name = normalizeMcpName(text);
    if (!name || name.length > 64) return { layer: null, id: null, name };
    for (const alias of INNER_PROJECT_ALIASES) {
        if (alias.re.test(name)) return { layer: 'inner_project', id: alias.id, name };
    }
    for (const alias of CONNECTOR_ALIASES) {
        if (alias.re.test(name)) return { layer: 'connector', id: alias.id, name };
    }
    return { layer: 'unknown', id: null, name };
}

function splitGeminiMcpNames(names) {
    const connectors = [];
    const innerProjects = [];
    const unknown = [];
    for (const raw of names || []) {
        const row = classifyGeminiMcpName(raw);
        if (row.layer === 'connector') connectors.push(row);
        else if (row.layer === 'inner_project') innerProjects.push(row);
        else if (row.name) unknown.push(row);
    }
    return { connectors, innerProjects, unknown };
}

async function readComposerMcpLayers(page) {
    const names = await page.evaluate(() => {
        const out = [];
        const seen = new Set();
        const root = document.querySelector('form') || document.body;
        if (!root) return out;
        for (const el of root.querySelectorAll(
            'button, [role="button"], [role="listitem"], [class*="chip"], [class*="mention"], [class*="pill"]'
        )) {
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            const key = text.toLowerCase();
            if (!text || text.length > 64 || seen.has(key)) continue;
            seen.add(key);
            out.push(text);
        }
        return out;
    }).catch(() => []);
    return splitGeminiMcpNames(names);
}

function logMcpLayers(log, layers) {
    const connectors = (layers && layers.connectors || []).map(row => row.name).join(', ') || '(none)';
    const inner = (layers && layers.innerProjects || []).map(row => row.name).join(', ') || '(none)';
    log(`gemini: mcp connectors (top-level @): ${connectors}`);
    log(`gemini: mcp inner projects (not @ chips): ${inner}`);
}

const WEBCODEX_LOCAL_PROJECTS_RE = /webcodex\s+local\s+projects/i;
const MENTION_REJECT_RE = /skillwiki|grok[\s_-]*search|^trends$|虛擬替身|虚拟替身|^技能$|^skills?$|google\s+(keep|tasks|drive)|gmail|^workspace$|verify\s+ai|notebook/i;

function isGeminiMcpMentionDisabled(raw) {
    const source = arguments.length > 0 ? raw : process.env.AGENTCHAT_GEMINI_NO_MCP_MENTION;
    return String(source == null ? '' : source).trim() === '1';
}

function mentionItemText(item) {
    if (!item) return '';
    return normalizeMcpName(item.aria || item.ariaLabel || item.title || item.text || item.t || '');
}

function findWebcodexMentionMenuItem(items) {
    for (const item of items || []) {
        const name = mentionItemText(item);
        if (!name) continue;
        const classified = classifyGeminiMcpName(name);
        if (classified.layer === 'inner_project') continue;
        if (classified.id === 'skillwiki') continue;
        if (MENTION_REJECT_RE.test(name)) continue;
        if (WEBCODEX_LOCAL_PROJECTS_RE.test(name)) return item;
    }
    return null;
}

function isGeminiAppUrl(url) {
    return /gemini\.google\.com\/(?:u\/\d+\/)?app(?:\/|$|\?)/i.test(String(url || ''));
}

function composerHasWebcodexMentionInDoc(doc) {
    const root = doc && (doc.querySelector('.ql-editor')
        || doc.querySelector('[contenteditable="true"][role="textbox"]')
        || doc.querySelector('rich-textarea'));
    if (!root) return false;
    const text = normalizeMcpName(root.innerText || root.textContent || '');
    if (WEBCODEX_LOCAL_PROJECTS_RE.test(text)) return true;
    const html = String(root.innerHTML || '');
    return /webcodex/i.test(html) && /mention|chip|pill/i.test(html);
}

async function composerHasWebcodexMention(page) {
    return page.evaluate(() => {
        const root = document.querySelector('.ql-editor')
            || document.querySelector('[contenteditable="true"][role="textbox"]')
            || document.querySelector('rich-textarea');
        if (!root) return false;
        const text = (root.innerText || root.textContent || '').replace(/\s+/g, ' ').trim();
        if (/webcodex\s+local\s+projects/i.test(text)) return true;
        const html = String(root.innerHTML || '');
        return /webcodex/i.test(html) && /mention|chip|pill/i.test(html);
    }).catch(() => false);
}

async function listMentionMenuItems(page) {
    return page.evaluate(() => {
        const items = [];
        for (const el of document.querySelectorAll('[role="menuitem"].at-mentions-v2-item, [role="menuitem"]')) {
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
            const aria = el.getAttribute('aria-label') || '';
            if (!text && !aria) continue;
            items.push({
                text,
                aria,
                cls: String(el.className || ''),
                box: { x: r.x, y: r.y, w: r.width, h: r.height },
            });
        }
        return items;
    }).catch(() => []);
}

async function dismissStrayMentionQuery(page) {
    if (page.keyboard && page.keyboard.press) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout?.(200);
        await page.keyboard.press('Backspace').catch(() => {});
        await page.waitForTimeout?.(80);
        // "@Webcodex" leftover is longer than one Backspace.
        for (let i = 0; i < 12; i++) {
            const leftover = await page.evaluate(() => {
                const root = document.querySelector('.ql-editor');
                const text = (root && (root.innerText || root.textContent) || '').replace(/\s+/g, '');
                return /^@/.test(text);
            }).catch(() => false);
            if (!leftover) break;
            await page.keyboard.press('Backspace').catch(() => {});
        }
    }
}

async function placeCaretAfterGeminiMention(page) {
    try {
        await page.evaluate(() => {
            const editor = document.querySelector('.ql-editor')
                || document.querySelector('[contenteditable="true"][role="textbox"]');
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

async function clickMentionMenuItem(page, item) {
    if (item && item.box && page.mouse && page.mouse.click) {
        const cx = item.box.x + item.box.w / 2;
        const cy = item.box.y + item.box.h / 2;
        if (Number.isFinite(cx) && Number.isFinite(cy)) {
            await page.mouse.move(cx, cy);
            await page.mouse.click(cx, cy);
            return true;
        }
    }
    if (page.locator) {
        const loc = page.locator('[role="menuitem"].at-mentions-v2-item, [role="menuitem"]')
            .filter({ hasText: /Webcodex\s+Local\s+Projects/i })
            .first();
        try {
            await loc.click({ timeout: 2000 });
            return true;
        } catch (_) { /* fall through */ }
    }
    return page.evaluate(() => {
        const el = [...document.querySelectorAll('[role="menuitem"]')]
            .find(node => /webcodex\s+local\s+projects/i.test(
                (node.getAttribute('aria-label') || '') + ' ' + (node.innerText || '')
            ));
        if (el && typeof el.click === 'function') {
            el.click();
            return true;
        }
        return false;
    }).catch(() => false);
}

/**
 * Task-mode Gemini binds WebCodex only when `@Webcodex Local Projects` is a
 * composer mention chip. Type `@Webcodex` (not bare `@`) so Avatar/Skills
 * are not first. Never Enter the first built-in row. Never pick SkillWiki,
 * GrokSearch, or trends.
 */
async function ensureGeminiWebcodexMention(page, log) {
    const write = typeof log === 'function' ? log : () => {};
    if (isGeminiMcpMentionDisabled()) {
        write('gemini: @Webcodex Local Projects mention skipped (AGENTCHAT_GEMINI_NO_MCP_MENTION=1)');
        return 'skipped';
    }
    try {
        if (await composerHasWebcodexMention(page)) {
            write('gemini: @Webcodex Local Projects mention already on');
            return 'already-on';
        }

        const beforeUrl = page.url ? page.url() : '';
        const editor = page.locator
            ? page.locator('.ql-editor, [contenteditable="true"][role="textbox"]').first()
            : null;
        if (editor) {
            await editor.click({ timeout: 5000 }).catch(() => {});
        }

        if (page.keyboard && page.keyboard.type) {
            await page.keyboard.type('@Webcodex');
        } else if (page.keyboard && page.keyboard.insertText) {
            await page.keyboard.insertText('@Webcodex');
        } else {
            return 'missing';
        }
        await page.waitForTimeout?.(700);

        const items = await listMentionMenuItems(page);
        const pick = findWebcodexMentionMenuItem(items);
        if (!pick) {
            write('gemini: @ mention menu has no Webcodex Local Projects row');
            await dismissStrayMentionQuery(page);
            return 'missing';
        }

        const clicked = await clickMentionMenuItem(page, pick);
        if (!clicked) {
            write('gemini: @Webcodex Local Projects row found but click failed');
            await dismissStrayMentionQuery(page);
            return 'missing';
        }
        await page.waitForTimeout?.(600);

        const afterUrl = page.url ? page.url() : beforeUrl;
        if (beforeUrl && afterUrl && !isGeminiAppUrl(afterUrl)) {
            write(`gemini: mention pick left app (${afterUrl})`);
            try {
                if (page.goto && isGeminiAppUrl(beforeUrl)) {
                    await page.goto(beforeUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
                }
            } catch (_) { /* stay fail-closed */ }
            return 'missing';
        }

        if (await composerHasWebcodexMention(page)) {
            write('gemini: @Webcodex Local Projects mention inserted');
            return 'clicked';
        }
        write('gemini: @Webcodex Local Projects clicked but chip not verified');
        await dismissStrayMentionQuery(page);
        return 'missing';
    } catch (err) {
        write(`gemini: ensureGeminiWebcodexMention error: ${err && err.message}`);
        await dismissStrayMentionQuery(page);
        return 'error';
    }
}

module.exports = {
    classifyGeminiMcpName,
    splitGeminiMcpNames,
    readComposerMcpLayers,
    logMcpLayers,
    isGeminiMcpMentionDisabled,
    findWebcodexMentionMenuItem,
    isGeminiAppUrl,
    composerHasWebcodexMentionInDoc,
    composerHasWebcodexMention,
    placeCaretAfterGeminiMention,
    ensureGeminiWebcodexMention,
};
