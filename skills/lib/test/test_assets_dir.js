#!/usr/bin/env node
'use strict';

/**
 * Pin the provider-extracted image destination.
 *
 * Default is $HOME/.agentchat/assets (same user-level tree as sessions/.env).
 * cwd is never the implicit dest — that is what dropped ai-image-* into
 * whatever repo invoked the skill.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { resolveAssetsDir, ensureAssetsDir } = require('../assetsDir');

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_DATA_URI = `data:image/png;base64,${PNG_B64}`;

let pass = 0, fail = 0;
async function test(name, fn) {
    const saved = {
        HOME: process.env.HOME,
        AGENTCHAT_HOME: process.env.AGENTCHAT_HOME,
        AGENTCHAT_ASSETS_DIR: process.env.AGENTCHAT_ASSETS_DIR,
        USERPROFILE: process.env.USERPROFILE,
    };
    try {
        await fn();
        pass++;
        console.log('  PASS', name);
    } catch (err) {
        fail++;
        console.log('  FAIL', name, err && err.message);
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

function isolateHome(home) {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.AGENTCHAT_HOME;
    delete process.env.AGENTCHAT_ASSETS_DIR;
}

(async () => {
await test('default is $HOME/.agentchat/assets', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-home-'));
    isolateHome(home);
    assert.strictEqual(resolveAssetsDir(), path.join(home, '.agentchat', 'assets'));
});

await test('AGENTCHAT_HOME/assets wins over $HOME/.agentchat/assets', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-home-'));
    const acHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-homevar-'));
    isolateHome(home);
    process.env.AGENTCHAT_HOME = acHome;
    assert.strictEqual(resolveAssetsDir(), path.join(acHome, 'assets'));
});

await test('AGENTCHAT_ASSETS_DIR wins over AGENTCHAT_HOME', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-home-'));
    const acHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-homevar-'));
    const assets = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-assets-'));
    isolateHome(home);
    process.env.AGENTCHAT_HOME = acHome;
    process.env.AGENTCHAT_ASSETS_DIR = assets;
    assert.strictEqual(resolveAssetsDir(), assets);
});

await test('cli --download-dir wins over env', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-home-'));
    const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-env-'));
    const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-cli-'));
    isolateHome(home);
    process.env.AGENTCHAT_ASSETS_DIR = envDir;
    assert.strictEqual(resolveAssetsDir(cliDir), cliDir);
});

await test('empty / whitespace overrides fall through', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-home-'));
    isolateHome(home);
    process.env.AGENTCHAT_ASSETS_DIR = '   ';
    process.env.AGENTCHAT_HOME = '';
    assert.strictEqual(resolveAssetsDir('  '), path.join(home, '.agentchat', 'assets'));
});

await test('relative cli dir resolves against cwd', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-home-'));
    isolateHome(home);
    assert.strictEqual(resolveAssetsDir('.agentchat/assets'), path.resolve('.agentchat/assets'));
});

await test('path containing = is preserved', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-home-'));
    isolateHome(home);
    const dir = path.join(home, 'out=dir');
    assert.strictEqual(resolveAssetsDir(dir), dir);
});

await test('tilde in AGENTCHAT_ASSETS_DIR is literal, not expanded', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-home-'));
    isolateHome(home);
    process.env.AGENTCHAT_ASSETS_DIR = '~/not-expanded';
    assert.strictEqual(resolveAssetsDir(), path.resolve('~/not-expanded'));
});

await test('ensureAssetsDir creates the directory', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-home-'));
    isolateHome(home);
    const dir = ensureAssetsDir();
    assert.strictEqual(dir, path.join(home, '.agentchat', 'assets'));
    assert.ok(fs.statSync(dir).isDirectory());
});

await test('cwd is not the implicit destination', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-home-'));
    isolateHome(home);
    assert.notStrictEqual(resolveAssetsDir(), process.cwd());
});

await test('OneWeb main() uses resolveAssetsDir, not process.cwd()', () => {
    const src = fs.readFileSync(path.join(ROOT, 'skills/AgentChat-OneWeb/index.js'), 'utf8');
    assert.ok(/resolveAssetsDir\(/.test(src), 'main resolves the assets dir');
    assert.ok(
        !/downloadAllImages\(result\.response,\s*process\.cwd\(\)/.test(src),
        'main no longer passes process.cwd() as destDir'
    );
    assert.ok(/downloadAllImages\(result\.response,\s*destDir,\s*\{\s*page:\s*result\.page\s*\}\)/.test(src),
        'main forwards result.page with destDir');
    assert.ok(/--download-dir=/.test(src), 'CLI override is parsed');
    const flagBlock = src.match(/startsWith\('--download-dir='\)[\s\S]{0,280}/);
    assert.ok(flagBlock, 'download-dir parse block present');
    assert.ok(flagBlock[0].includes(".slice('--download-dir='.length)"), 'prefix slice, not split on =');
    assert.ok(!flagBlock[0].includes("split('=')"), 'download-dir parse does not split on =');
    assert.ok(/if \(downloadImages\)/.test(src), 'download gated so --no-download-images skips dest');
});

await test('repo gitignore catches cwd leftovers and an in-repo .agentchat cache', () => {
    const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    assert.ok(/\/ai-image-\*/.test(gi), 'root ai-image-* leftovers ignored');
    assert.ok(/\/\.agentchat\//.test(gi), 'optional in-repo .agentchat/ ignored');
});

await test('downloadAllImages mkdir nested dest for a data-URI; no-URL skips mkdir', async () => {
    const { downloadAllImages } = require(path.join(ROOT, 'skills/AgentChat-OneWeb/index.js'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-dl-'));
    const nested = path.join(tmp, 'nested', 'assets');
    assert.ok(!fs.existsSync(nested), 'nested dest starts absent');
    const r = await downloadAllImages(`![px](${PNG_DATA_URI})`, nested, {});
    assert.strictEqual(r.downloaded.length, 1, 'one image written');
    assert.ok(fs.statSync(nested).isDirectory(), 'nested dest created on write');
    assert.ok(fs.existsSync(path.join(nested, r.downloaded[0].file)), 'file landed in nested dest');

    const emptyDest = path.join(tmp, 'empty-should-not-exist');
    const empty = await downloadAllImages('no images in this response', emptyDest, {});
    assert.strictEqual(empty.downloaded.length, 0);
    assert.ok(!fs.existsSync(emptyDest), 'no-URL must not create dest');
});

await test('non-directory dest fails the phase and leaves dest as a file', async () => {
    const { downloadAllImages } = require(path.join(ROOT, 'skills/AgentChat-OneWeb/index.js'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-dl-'));
    const blocker = path.join(tmp, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    let threw = null;
    try {
        await downloadAllImages(`![px](${PNG_DATA_URI})`, blocker, {});
    } catch (err) {
        threw = err;
    }
    assert.ok(threw, 'mkdir/write against a file must throw');
    assert.strictEqual(fs.readFileSync(blocker, 'utf8'), 'x', 'blocker file contents preserved');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
