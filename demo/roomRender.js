/**
 * Demo-room markdown: HTML-escape plus GFM pipe tables.
 * Full markdown is out of scope. Cell text stays escaped.
 */
'use strict';

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function splitRow(line) {
    let t = String(line).trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|')) t = t.slice(0, -1);
    return t.split('|').map((c) => c.trim());
}

function isSeparatorLine(line) {
    const cells = splitRow(line);
    return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c.replace(/\s+/g, '')));
}

function isPipeRow(line) {
    return /\|/.test(line) && String(line).trim().length > 0;
}

function alignOf(sepCell) {
    const t = String(sepCell || '').replace(/\s+/g, '');
    const left = t.startsWith(':');
    const right = t.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
}

function cell(tag, text, align) {
    const style = align && align !== 'left' ? ` style="text-align:${align}"` : '';
    return `<${tag}${style}>${escapeHtml(text)}</${tag}>`;
}

function renderTable(headerLine, sepLine, bodyLines) {
    const headers = splitRow(headerLine);
    const seps = splitRow(sepLine);
    const colCount = Math.max(headers.length, seps.length, 1);
    const align = [];
    for (let i = 0; i < colCount; i++) align.push(alignOf(seps[i]));
    const ths = [];
    for (let i = 0; i < colCount; i++) ths.push(cell('th', headers[i] || '', align[i]));
    const rows = bodyLines.map((line) => {
        const cells = splitRow(line);
        const tds = [];
        for (let i = 0; i < colCount; i++) tds.push(cell('td', cells[i] || '', align[i]));
        return `<tr>${tds.join('')}</tr>`;
    });
    return `<table class="gfm-table"><thead><tr>${ths.join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function renderRoomMarkdown(text) {
    const lines = String(text ?? '').split(/\r?\n/);
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const next = lines[i + 1];
        if (
            next != null
            && isPipeRow(lines[i])
            && isSeparatorLine(next)
            && splitRow(lines[i]).length > 0
        ) {
            const header = lines[i];
            const sep = next;
            i += 2;
            const body = [];
            while (i < lines.length && isPipeRow(lines[i]) && !isSeparatorLine(lines[i])) {
                body.push(lines[i]);
                i += 1;
            }
            out.push(renderTable(header, sep, body));
            continue;
        }
        out.push(escapeHtml(lines[i]));
        i += 1;
    }
    return out.join('\n');
}

const api = { escapeHtml, renderRoomMarkdown };
if (typeof module === 'object' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') {
    globalThis.escapeHtml = escapeHtml;
    globalThis.renderRoomMarkdown = renderRoomMarkdown;
}
