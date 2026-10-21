#!/usr/bin/env node
'use strict';

/**
 * test_blob_image_capture.js — blob: → data URI conversion in
 * collectResponseImages (fetch + FileReader path, replacing the v13 canvas
 * path that died on Muse's tainted-canvas blob images):
 *
 *   B1  blob: src is converted via fetch(blobUrl) → FileReader.readAsDataURL
 *       and the resulting data URI is captured (skippedUncapturable stays 0).
 *   B2  a failing blob fetch skips the image and surfaces the REAL error
 *       string ("blob fetch failed: <err>") in skipReasons.
 *   B3  https: srcs never touch fetch; data: srcs pass through unchanged;
 *       unknown schemes are skipped with an "unknown scheme" reason.
 *   B4  end-to-end through extractResponse: the converted data URI lands in
 *       the returned markdown.
 *
 * No network: fetch and FileReader are stubbed globals; the in-page callback
 * runs in-process via the mock locator (same pattern as test_v13).
 */
const assert = require('assert');
const path = require('path');

const AGENTCHAT_ROOT = path.resolve(__dirname, '..', '..', '..');
const { collectResponseImages, extractResponse } = require(
    path.join(AGENTCHAT_ROOT, 'skills', 'lib', 'providerFactory')
);

let passed = 0, total = 0;
async function ok(name, fn) {
    total++;
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ✗ ${name}\n    ${e && e.stack || e}`);
        process.exitCode = 1;
    }
}

// Minimal DOM mocks — same surface the v13 suite uses, plus the two gaps its
// mocks had rotted on: cloneNode (IN_PAGE_TEXT_WITH_MATH clones the node) and
// the bare `document` global the callback's shadow-DOM walk starts from.
function el(tag, { text = '', imgs = [] } = {}) {
    const node = {
        tagName: tag,
        innerText: text,
        textContent: text,
        querySelectorAll: (sel) => (sel === 'img' ? imgs : []),
        closest: () => null,
        getBoundingClientRect: () => ({ width: 0, height: 0 }),
    };
    // IN_PAGE_TEXT_WITH_MATH clones and strips .katex/mjx nodes — the clone
    // only needs the text surface plus no-op querySelectorAll.
    node.cloneNode = () => ({
        innerText: text,
        textContent: text,
        querySelectorAll: () => ({ forEach: () => {} }),
    });
    return node;
}
function img({ src, alt = '', w = 1024, h = 768 }) {
    return {
        tagName: 'IMG', currentSrc: src, src, alt,
        naturalWidth: w, naturalHeight: h,
        getBoundingClientRect: () => ({ width: w, height: h }),
    };
}
// The in-page callback reads the bare `document` global (roots = [document]);
// in this in-process harness the scope node stands in for it.
function mockResponseEl(node) {
    return {
        evaluate: async (fn, args) => {
            const prev = global.document;
            global.document = node;
            try { return await fn(node, args); }
            finally { global.document = prev; }
        },
    };
}

const PNG_B64 = Buffer.from('fake-png-bytes-for-blob-test').toString('base64');
const DATA_URI = `data:image/png;base64,${PNG_B64}`;

function stubFetchFileReader({ fetchImpl }) {
    const savedFetch = globalThis.fetch;
    const savedFileReader = globalThis.FileReader;
    globalThis.fetch = fetchImpl;
    globalThis.FileReader = class {
        readAsDataURL(blob) {
            // The stub blob carries { b64 } straight from the fetch stub.
            this.result = `data:${blob.type || 'image/png'};base64,${blob.b64}`;
            if (this.onload) this.onload();
        }
    };
    return () => {
        if (savedFetch === undefined) delete globalThis.fetch; else globalThis.fetch = savedFetch;
        if (savedFileReader === undefined) delete globalThis.FileReader; else globalThis.FileReader = savedFileReader;
    };
}

(async () => {
    console.log('blob: image capture (fetch + FileReader) tests');

    await ok('B1: blob: src converts to a data URI via fetch + FileReader', async () => {
        let fetched = null;
        const restore = stubFetchFileReader({
            fetchImpl: async (url) => {
                fetched = url;
                return { ok: true, status: 200, blob: async () => ({ type: 'image/png', b64: PNG_B64 }) };
            },
        });
        try {
            const node = el('DIV', { imgs: [img({ src: 'blob:https://muse.ai/deadbeef-cafe', alt: 'generated' })] });
            const r = await collectResponseImages(mockResponseEl(node), { key: 'muse', imageMinPx: 64 });
            assert.strictEqual(fetched, 'blob:https://muse.ai/deadbeef-cafe', 'fetch called with the blob URL');
            assert.strictEqual(r.skippedUncapturable, 0, `nothing skipped: ${JSON.stringify(r.skipReasons)}`);
            assert.strictEqual(r.images.length, 1);
            assert.strictEqual(r.images[0].src, DATA_URI, 'data URI carries the blob payload');
        } finally {
            restore();
        }
    });

    await ok('B2: failing blob fetch skips with the REAL error in skipReasons', async () => {
        const restore = stubFetchFileReader({
            fetchImpl: async () => { throw new Error('network gone'); },
        });
        try {
            const node = el('DIV', { imgs: [img({ src: 'blob:https://muse.ai/deadbeef-cafe' })] });
            const r = await collectResponseImages(mockResponseEl(node), { key: 'muse', imageMinPx: 64 });
            assert.strictEqual(r.images.length, 0);
            assert.strictEqual(r.skippedUncapturable, 1);
            assert.strictEqual(r.skipReasons.length, 1);
            assert(/blob fetch failed: network gone/.test(r.skipReasons[0]),
                `real error surfaced, got: ${r.skipReasons[0]}`);
        } finally {
            restore();
        }
    });

    await ok('B3: https/data pass through untouched; unknown schemes named in the reason', async () => {
        let fetchCalls = 0;
        const restore = stubFetchFileReader({
            fetchImpl: async () => { fetchCalls++; throw new Error('must not be called'); },
        });
        try {
            const node = el('DIV', {
                imgs: [
                    img({ src: 'https://cdn.example.com/generated.png' }),
                    img({ src: 'data:image/png;base64,aGVsbG8=' }),
                    img({ src: 'chrome-extension://abc/icon.png' }),
                ],
            });
            const r = await collectResponseImages(mockResponseEl(node), { key: 'muse', imageMinPx: 64 });
            assert.strictEqual(fetchCalls, 0, 'fetch is only for blob: srcs');
            assert.strictEqual(r.images.length, 2);
            assert.strictEqual(r.images[0].src, 'https://cdn.example.com/generated.png');
            assert.strictEqual(r.images[1].src, 'data:image/png;base64,aGVsbG8=');
            assert.strictEqual(r.skippedUncapturable, 1);
            assert(/unknown scheme: chrome-extension/.test(r.skipReasons[0]), `got: ${r.skipReasons[0]}`);
        } finally {
            restore();
        }
    });

    await ok('B4: extractResponse appends the converted data URI as markdown', async () => {
        const restore = stubFetchFileReader({
            fetchImpl: async () => ({ ok: true, status: 200, blob: async () => ({ type: 'image/png', b64: PNG_B64 }) }),
        });
        try {
            const node = el('DIV', {
                text: 'Here is the orchestration infographic you asked for, rendered below.',
                imgs: [img({ src: 'blob:https://muse.ai/feed-face-node', alt: 'orchestration infographic' })],
            });
            const out = await extractResponse({}, mockResponseEl(node), {
                key: 'muse', minResponseLength: 5, captureImages: true, imageMinPx: 64,
            }, 'draw the orchestration infographic');
            assert(out, 'extraction must not be null');
            assert(out.includes(`](${DATA_URI})`), 'data URI appended as a markdown image ref');
            assert(/!\[orchestration infographic 1024x768\]/.test(out), 'alt + dimensions in the label');
        } finally {
            restore();
        }
    });

    console.log(`\n${passed}/${total} assertion groups passed`);
})();
