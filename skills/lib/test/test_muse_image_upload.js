#!/usr/bin/env node
'use strict';

/**
 * Muse image upload path (v24.1).
 *
 * muse.ai's CSP rejects `fetch('data:…')`, which kills BOTH clipboard tiers in
 * pasteImagesToEditor. The adapter therefore declares `imageUpload:'file-input'`
 * and the pipeline attaches through the composer's real input[type=file].
 *
 * These tests pin the two halves of that contract with stubbed page objects:
 * the adapter flag, and attachImagesViaFileInput's scope + confirmation logic.
 */
const assert = require('assert');

const muse = require('../providers/adapters/muse');
const { attachImagesViaFileInput } = require('../providerFactory');

let pass = 0, fail = 0;
const test = async (name, fn) => {
    try {
        await fn();
        pass++;
        console.log('  PASS', name);
    } catch (err) {
        fail++;
        console.log('  FAIL', name, err && err.message);
    }
};

/**
 * Minimal page/editor stubs. `chipCount` models the composer's
 * "Remove attachment" buttons; `setInputFiles` bumps it to simulate a UI that
 * accepts the upload. `inputFound:false` models a composer with no file input.
 */
function makeStubs({ inputFound = true, chipCount = 0, acceptUpload = true } = {}) {
    const state = { chips: chipCount, setCalls: [] };
    const inputEl = inputFound
        ? {
            setInputFiles: async (p) => {
                state.setCalls.push(p);
                if (acceptUpload) {
                    state.chips += Array.isArray(p) ? p.length : 1;
                }
            },
        }
        : null;
    const editor = {
        evaluateHandle: async () => ({ asElement: () => inputEl }),
    };
    const page = {
        evaluate: async () => state.chips,
        waitForTimeout: async () => {},
    };
    return { page, editor, state };
}

async function main() {
    await test('adapter declares the file-input upload path', () => {
        assert.strictEqual(muse.imageUpload, 'file-input');
        assert.ok(muse.imageUploadConfirmSelector, 'chip selector is adapter-owned');
    });

    await test('clipboard tiers are still the non-muse default', () => {
        const gemini = require('../providers/adapters/gemini');
        assert.notStrictEqual(gemini.imageUpload, 'file-input');
    });

    await test('attaches each image through the composer file input', async () => {
        const { page, editor, state } = makeStubs();
        const ok = await attachImagesViaFileInput(
            page, editor,
            [{ path: '/tmp/a.png', fileName: 'a.png' }],
            () => {}
        );
        assert.strictEqual(ok, true, 'reports success when the chip appears');
        assert.deepStrictEqual(state.setCalls, [['/tmp/a.png']]);
    });

    await test('multiple images attach in order', async () => {
        const { page, editor, state } = makeStubs();
        const ok = await attachImagesViaFileInput(
            page, editor,
            [
                { path: '/tmp/a.png', fileName: 'a.png' },
                { path: '/tmp/b.jpg', fileName: 'b.jpg' },
            ],
            () => {}
        );
        assert.strictEqual(ok, true);
        assert.deepStrictEqual(state.setCalls, [['/tmp/a.png', '/tmp/b.jpg']]);
    });

    await test('fails when the UI never shows the attachment chip', async () => {
        // acceptUpload:false → setInputFiles resolves but no chip is rendered.
        const { page, editor } = makeStubs({ acceptUpload: false });
        const ok = await attachImagesViaFileInput(
            page, editor,
            [{ path: '/tmp/a.png', fileName: 'a.png' }],
            () => {}
        );
        assert.strictEqual(ok, false, 'silent no-op must not be reported as success');
    });

    await test('fails when the composer has no file input', async () => {
        const { page, editor, state } = makeStubs({ inputFound: false });
        const ok = await attachImagesViaFileInput(
            page, editor,
            [{ path: '/tmp/a.png', fileName: 'a.png' }],
            () => {}
        );
        assert.strictEqual(ok, false);
        assert.deepStrictEqual(state.setCalls, []);
    });

    await test('image without a filesystem path is rejected', async () => {
        // The clipboard path carries base64 only; the file-input path needs a
        // real path, so it must fail loudly rather than attach nothing.
        const { page, editor, state } = makeStubs();
        const ok = await attachImagesViaFileInput(
            page, editor,
            [{ base64: 'AAAA', fileName: 'a.png' }],
            () => {}
        );
        assert.strictEqual(ok, false);
        assert.deepStrictEqual(state.setCalls, []);
    });

    await test('baseline chips are respected, not assumed empty', async () => {
        // A composer that already holds 1 attachment needs 2 chips after adding 1.
        const { page, editor } = makeStubs({ chipCount: 1, acceptUpload: false });
        const ok = await attachImagesViaFileInput(
            page, editor,
            [{ path: '/tmp/a.png', fileName: 'a.png' }],
            () => {}
        );
        assert.strictEqual(ok, false, '1 chip when 2 expected is not confirmation');
    });

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}

main();
