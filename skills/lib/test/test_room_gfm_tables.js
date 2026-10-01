#!/usr/bin/env node
'use strict';

/**
 * Demo-room GFM pipe tables vs raw-pipe escape.
 * No Chrome, no :8737.
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { escapeHtml, renderRoomMarkdown } = require(path.join(ROOT, 'demo/roomRender.js'));

let pass = 0;
let fail = 0;
function assert(name, actual, expected = true) {
    if (actual === expected) {
        pass += 1;
        console.log('PASS', name);
    } else {
        fail += 1;
        console.log('FAIL', name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

const GFM = [
    '| Col A | Col B |',
    '| --- | --- |',
    '| 1 | 2 |',
].join('\n');

function legacyH(s) {
    const d = new JSDOM('<!doctype html><html><body></body></html>').window.document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

console.log('T1: legacy escape-only h() leaves raw pipes');
const legacy = legacyH(GFM);
assert('legacy HTML has no <table', /<table/i.test(legacy), false);
assert('legacy pipes stay visible', legacy.includes('| Col A |') && legacy.includes('| 1 | 2 |'));

console.log('\nT2: room renderer turns GFM pipes into a table');
const html = renderRoomMarkdown(GFM);
assert('emits gfm-table', html.includes('<table class="gfm-table">'));
assert('header cell Col A', html.includes('<th>Col A</th>'));
assert('header cell Col B', html.includes('<th>Col B</th>'));
assert('body cell 1', html.includes('<td>1</td>'));
assert('body cell 2', html.includes('<td>2</td>'));
assert('source pipes are not the rendered body', html.includes('| Col A |'), false);

console.log('\nT3: non-table pipes stay escaped text');
const lonely = renderRoomMarkdown('use | as a delimiter');
assert('lonely pipe has no table', /<table/i.test(lonely), false);
assert('lonely pipe remains text', lonely.includes('use | as a delimiter'));

console.log('\nT4: cell HTML is escaped');
const xss = renderRoomMarkdown('| x |\n| --- |\n| <script>alert(1)</script> |');
assert('xss table still a table', xss.includes('<table class="gfm-table">'));
assert('script tag escaped', xss.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
assert('raw script tag absent', xss.includes('<script>'), false);

console.log('\nT5: prose around a table stays escaped');
const mixed = renderRoomMarkdown(`hello <b>\n${GFM}\nbye`);
assert('mixed starts with escaped prose', mixed.startsWith('hello &lt;b&gt;'));
assert('mixed contains table', mixed.includes('<table class="gfm-table">'));
assert('mixed keeps trailing prose', mixed.includes('\nbye'));

console.log('\nT6: alignment markers');
const aligned = renderRoomMarkdown('| L | C | R |\n| --- | :---: | ---: |\n| a | b | c |');
assert('center align', aligned.includes('text-align:center'));
assert('right align', aligned.includes('text-align:right'));

console.log('\nT7: demo pages load the renderer instead of escape-only h()');
const webext = fs.readFileSync(path.join(ROOT, 'demo/webextended.html'), 'utf8');
const parallel = fs.readFileSync(path.join(ROOT, 'demo/freesubagent.html'), 'utf8');
assert('webextended includes roomRender.js', webext.includes('src="roomRender.js"'));
assert('freesubagent includes roomRender.js', parallel.includes('src="roomRender.js"'));
assert('webextended bubbles use renderRoomMarkdown', /function h\(s\)\{return renderRoomMarkdown\(s\)\}/.test(webext));
assert('freesubagent bubbles use renderRoomMarkdown', /function h\(s\)\{return renderRoomMarkdown\(s\)\}/.test(parallel));
assert('webextended dropped textContent-only h()', webext.includes("d.textContent=s;return d.innerHTML"), false);
assert('escapeHtml is exported', typeof escapeHtml === 'function');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
