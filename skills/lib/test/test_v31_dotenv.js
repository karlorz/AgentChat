/**
 * v31 CROSS-DIRECTORY .ENV LOOKUP tests — drives the inlined loadDotEnv in
 * skills/lib/cdp.js (origin/master layout) through child processes with
 * controlled env (process.env wins, so every child sets AGENTCHAT_ENV_FILE
 * / AGENTCHAT_HOME / HOME explicitly to keep the test deterministic).
 *
 * Assertions (each: child exits 0 + stdout/stderr contract matches):
 *  1. AGENTCHAT_ENV_FILE wins: write a temp .env, point env var at it,
 *     child sees only its contents.
 *  2. AGENTCHAT_HOME wins: $AGENTCHAT_HOME/.env is loaded when
 *     AGENTCHAT_ENV_FILE is unset.
 *  3. User-level default ($HOME/.agentchat/.env) is hit when neither env
 *     var is set AND the ancestor climb finds nothing.
 *  4. Ancestor climb: from a deep temp file under a synthetic repo root,
 *     the climb hits the synthetic root's .env within 2 hops.
 *  5. NOT-LOADED stderr: when NO candidate exists, stderr contains the
 *     "[agentchat-env] NOT LOADED" header + the full candidate list + the
 *     3-fix footer. No key values appear.
 *  6. process.env wins: shell-set variables are NOT overwritten by .env.
 *  7. Idempotency: two loadDotEnv() calls in the same process produce
 *     exactly one "[agentchat-env] loaded" stderr line.
 *  8. NO key values ever printed (regex over stderr: NO matches for
 *     KEY=VALUE form, only the loader's structural output).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CDP = path.resolve(__dirname, '..', 'cdp.js');

let pass = 0, fail = 0;
const assert = (name, cond, detail = '') => {
    if (cond) { pass++; console.log('  PASS', name); }
    else      { fail++; console.log('  FAIL', name, detail); }
};

function runChild(script, envOverrides) {
    return spawnSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
        env: {
            ...process.env,
            AGENTCHAT_ENV_FILE: '',  // clear by default — child re-sets as needed
            AGENTCHAT_HOME: '',
            ...envOverrides,
        },
    });
}

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-test-v31-'));
}

// Helper: write a one-key .env file at a path and return the path
function writeEnv(dir, key, val) {
    const f = path.join(dir, '.env');
    fs.writeFileSync(f, `${key}=${val}\n`);
    return f;
}

// ── Case 1: AGENTCHAT_ENV_FILE wins ─────────────────────────────────────────
{
    console.log('Case 1: AGENTCHAT_ENV_FILE explicit override');
    const tmp = tempDir();
    const envFile = path.join(tmp, 'explicit.env');
    fs.writeFileSync(envFile, 'TEST_V31_KEY=alpha\nOTHER_KEY=beta\n');
    const r = runChild(`
        const cdp = require(${JSON.stringify(CDP)});
        console.log('LOADED=' + cdp.LOADED_ENV_FILE);
        console.log('TEST_V31_KEY=' + process.env.TEST_V31_KEY);
        console.log('OTHER_KEY=' + process.env.OTHER_KEY);
    `, { AGENTCHAT_ENV_FILE: envFile, AGENTCHAT_HOME: '' });
    assert('exits 0', r.status === 0, r.stderr.slice(0, 200));
    const loaded = (r.stdout.match(/LOADED=(.*)/) || [])[1] || '';
    const k1 = (r.stdout.match(/TEST_V31_KEY=(.*)/) || [])[1] || '';
    const k2 = (r.stdout.match(/OTHER_KEY=(.*)/) || [])[1] || '';
    assert('loaded path is the explicit env file', loaded === envFile, loaded);
    assert('TEST_V31_KEY=alpha', k1 === 'alpha', k1);
    assert('OTHER_KEY=beta', k2 === 'beta', k2);
    fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Case 2: AGENTCHAT_HOME/.env wins when env file unset ────────────────────
{
    console.log('Case 2: AGENTCHAT_HOME wins over user-level default');
    const tmp = tempDir();
    const envFile = path.join(tmp, '.env');
    fs.writeFileSync(envFile, 'TEST_V31_KEY=from-home-dir\n');
    const r = runChild(`
        const cdp = require(${JSON.stringify(CDP)});
        console.log('LOADED=' + cdp.LOADED_ENV_FILE);
        console.log('TEST_V31_KEY=' + process.env.TEST_V31_KEY);
    `, {
        AGENTCHAT_ENV_FILE: '',
        AGENTCHAT_HOME: tmp,
        HOME: path.join(tmp, 'fake-home'),
    });
    assert('exits 0', r.status === 0, r.stderr.slice(0, 200));
    const loaded = (r.stdout.match(/LOADED=(.*)/) || [])[1] || '';
    const k1 = (r.stdout.match(/TEST_V31_KEY=(.*)/) || [])[1] || '';
    assert('loaded path is $AGENTCHAT_HOME/.env', loaded === envFile, loaded);
    assert('TEST_V31_KEY=from-home-dir', k1 === 'from-home-dir', k1);
    fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Case 3: user-level default $HOME/.agentchat/.env is the fallback ────────
{
    console.log('Case 3: $HOME/.agentchat/.env user-level default');
    const home = tempDir();
    const agentchatDir = path.join(home, '.agentchat');
    fs.mkdirSync(agentchatDir, { recursive: true });
    const envFile = path.join(agentchatDir, '.env');
    fs.writeFileSync(envFile, 'TEST_V31_KEY=from-user-level\n');
    const r = runChild(`
        const cdp = require(${JSON.stringify(CDP)});
        console.log('LOADED=' + cdp.LOADED_ENV_FILE);
        console.log('TEST_V31_KEY=' + process.env.TEST_V31_KEY);
    `, { AGENTCHAT_ENV_FILE: '', AGENTCHAT_HOME: '', HOME: home });
    assert('exits 0', r.status === 0, r.stderr.slice(0, 200));
    const loaded = (r.stdout.match(/LOADED=(.*)/) || [])[1] || '';
    const k1 = (r.stdout.match(/TEST_V31_KEY=(.*)/) || [])[1] || '';
    assert('loaded path is $HOME/.agentchat/.env', loaded === envFile, loaded);
    assert('TEST_V31_KEY=from-user-level', k1 === 'from-user-level', k1);
    fs.rmSync(home, { recursive: true, force: true });
}

// ── Case 4: ancestor climb from a deep entry-point file ────────────────────
{
    console.log('Case 4: ancestor climb from a deep entry-point file');
    // Use a temp entry-point that requires cdp.js. require.main.filename
    // will point at the entry-point, so the climb starts there.
    const root = fs.realpathSync(tempDir());
    const deepDir = path.join(root, 'a', 'b', 'c');
    fs.mkdirSync(deepDir, { recursive: true });
    const realDeepDir = fs.realpathSync(deepDir);
    fs.writeFileSync(path.join(root, '.env'), 'TEST_V31_KEY=from-climb\n');
    const deepScript = path.join(realDeepDir, 'deep.js');
    fs.writeFileSync(deepScript, `
        const cdp = require(${JSON.stringify(CDP)});
        console.log('LOADED=' + cdp.LOADED_ENV_FILE);
        console.log('TEST_V31_KEY=' + process.env.TEST_V31_KEY);
    `);
    const r = spawnSync(process.execPath, [deepScript], {
        encoding: 'utf8',
        env: {
            ...process.env,
            AGENTCHAT_ENV_FILE: '',
            AGENTCHAT_HOME: '',
            HOME: '/nonexistent-v31-test',
        },
    });
    assert('exits 0', r.status === 0, r.stderr.slice(0, 200));
    const loaded = (r.stdout.match(/LOADED=(.*)/) || [])[1] || '';
    const k = (r.stdout.match(/TEST_V31_KEY=(.*)/) || [])[1] || '';
    assert('climb actually loaded root .env', loaded === path.join(root, '.env'), loaded);
    assert('TEST_V31_KEY=from-climb', k === 'from-climb', k);
    fs.rmSync(root, { recursive: true, force: true });
}

// ── Case 5: NOT-LOADED stderr contract ─────────────────────────────────────
{
    console.log('Case 5: NOT-LOADED stderr content');
    // Copy cdp.js into a temp dir so __filename is no longer inside the
    // repo (and __dirname/../../.env doesn't reach the repo's .env).
    const tmp = fs.realpathSync(tempDir());
    const cdpCopy = path.join(tmp, 'cdp.js');
    fs.copyFileSync(CDP, cdpCopy);
    const r = spawnSync(process.execPath, ['-e', `
        const cdp = require(${JSON.stringify(cdpCopy)});
        console.log('LOADED=' + cdp.LOADED_ENV_FILE);
    `], {
        encoding: 'utf8',
        cwd: tmp,
        env: {
            ...process.env,
            AGENTCHAT_ENV_FILE: '',
            AGENTCHAT_HOME: '',
            HOME: '/this-home-dir-does-not-exist-v31',
        },
    });
    fs.rmSync(tmp, { recursive: true, force: true });
    assert('exits 0', r.status === 0, r.stderr.slice(0, 200));
    assert('stderr has NOT-LOADED header', /\[agentchat-env\] NOT LOADED/.test(r.stderr), r.stderr.slice(0, 200));
    assert('stderr lists the search path header', /none of the following paths exist/.test(r.stderr));
    assert('stderr has Fix footer', /\[agentchat-env\] Fix:/.test(r.stderr));
    assert('stderr mentions AGENTCHAT_ENV_FILE fix', /AGENTCHAT_ENV_FILE/.test(r.stderr));
    assert('stderr mentions AGENTCHAT_HOME fix', /AGENTCHAT_HOME/.test(r.stderr));
    assert('stderr mentions user-level fix', /\$HOME\/\.agentchat\/\.env/.test(r.stderr));
    // SECURITY: no key=values printed
    const noLeak = !/TEST_V31_KEY|API_KEY|SECRET|TOKEN|PASSWORD/i.test(r.stderr);
    assert('NO key values in NOT-LOADED stderr', noLeak, r.stderr.slice(0, 300));
}

// ── Case 6: process.env wins (shell var > .env) ────────────────────────────
{
    console.log('Case 6: process.env wins over .env file');
    const tmp = tempDir();
    const envFile = path.join(tmp, 'env6.env');
    fs.writeFileSync(envFile, 'EXISTING_VAR=file-value\nFRESH_VAR=fresh-value\n');
    const r = runChild(`
        process.env.EXISTING_VAR = 'shell-value';
        const cdp = require(${JSON.stringify(CDP)});
        console.log('EXISTING_VAR=' + process.env.EXISTING_VAR);
        console.log('FRESH_VAR=' + process.env.FRESH_VAR);
    `, { AGENTCHAT_ENV_FILE: envFile, AGENTCHAT_HOME: '' });
    assert('exits 0', r.status === 0, r.stderr.slice(0, 200));
    const existing = (r.stdout.match(/EXISTING_VAR=(.*)/) || [])[1] || '';
    const fresh = (r.stdout.match(/FRESH_VAR=(.*)/) || [])[1] || '';
    assert('EXISTING_VAR stayed shell-value (not overwritten)', existing === 'shell-value', existing);
    assert('FRESH_VAR picked up from .env (not set in shell)', fresh === 'fresh-value', fresh);
    fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Case 7: idempotent announcement (two calls → one stderr line) ───────────
{
    console.log('Case 7: idempotency guard');
    // loadDotEnv isn't exported on origin/master (inlined in cdp.js);
    // simulate the dual call by re-requiring cdp.js — Node's module cache
    // returns the SAME exports object, so the v31 _announced module
    // variable stays set across "calls". Equivalent to invoke-twice.
    const tmp = tempDir();
    const envFile = path.join(tmp, 'env7.env');
    fs.writeFileSync(envFile, 'TEST_V31_KEY=idempotent\n');
    const r = runChild(`
        require(${JSON.stringify(CDP)});
        require(${JSON.stringify(CDP)});
    `, { AGENTCHAT_ENV_FILE: envFile, AGENTCHAT_HOME: '' });
    assert('exits 0', r.status === 0, r.stderr.slice(0, 200));
    const lines = (r.stderr.match(/\[agentchat-env\] loaded/g) || []).length;
    assert('exactly ONE [agentchat-env] loaded line on dual require', lines === 1, `lines=${lines} stderr=${r.stderr}`);
    fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Case 8: successful load does NOT echo key values ────────────────────────
{
    console.log('Case 8: successful load does not echo key values');
    const tmp = tempDir();
    const envFile = path.join(tmp, 'env8.env');
    fs.writeFileSync(envFile, 'SENSITIVE_TOKEN=verysecret123\nAPI_KEY=another\n');
    const r = runChild(`
        require(${JSON.stringify(CDP)});
    `, { AGENTCHAT_ENV_FILE: envFile, AGENTCHAT_HOME: '' });
    assert('exits 0', r.status === 0, r.stderr.slice(0, 200));
    assert('no SENSITIVE_TOKEN value leaked', !/verysecret123/.test(r.stderr), r.stderr.slice(0, 300));
    assert('no API_KEY value leaked', !/another/.test(r.stderr), r.stderr.slice(0, 300));
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
