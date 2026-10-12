#!/usr/bin/env node
'use strict';

/**
 * ChatGPT 2026 homepage chips + sidebar recents must not fail overlay_check.
 */
const assert = require('assert');
const path = require('path');

const chatgpt = require(path.join(__dirname, '../providers/adapters/chatgpt.js'));

const CHIP_TEXT = [
    'Find emails I can unsubscribe from',
    'Find the latest docs related to a project and summarize them.',
    'Prep me for my next mee',
].join('\n');

const patterns = chatgpt.skipOverlayPatterns || [];
assert.ok(patterns.length > 0, 'skipOverlayPatterns required');
assert.ok(
    patterns.some((p) => p.test(CHIP_TEXT)),
    'homepage starter chips must match skipOverlayPatterns'
);
assert.strictEqual(chatgpt.skipUndismissableFurniture, true);

const stop = chatgpt.stopSelectors || [];
assert.ok(stop.includes('button[data-testid="stop-button"]'));
assert.ok(stop.includes('button[aria-label="Stop streaming"]'));
assert.ok(stop.includes('button[data-testid="stop-generating-button"]'));
assert.ok(!stop.includes('button[aria-label="Stop"]'), 'bare Stop matches furniture');
const resp = chatgpt.responseSelectors || [];
assert.ok(resp.includes('[class*="MarkdownRoot"]'));
assert.ok(!resp.includes('[data-markdown-copy]'), 'user bubble also has data-markdown-copy');

console.log('PASS test_chatgpt_overlay_furniture');
process.exit(0);
