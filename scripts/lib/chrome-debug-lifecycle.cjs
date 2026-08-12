#!/usr/bin/env node
/**
 * chrome-debug-lifecycle.cjs — single shared Chrome CDP lifecycle engine.
 *
 * One engine, one command contract, every platform. All lifecycle policy
 * lives here: configuration resolution (CHROME_PROFILE canonical), hardened
 * launch flags, profile preparation, one-shot launch, opt-in daemon
 * supervision with bounded crash restart, validated owned stop/restart, and
 * diagnostics. Platform primitives (discovery, detached spawn, process
 * identity, owned-tree termination) live in the platform adapters.
 *
 * Invoked through scripts/chrome-debug (extensionless helper) on POSIX and
 * scripts/run-helper.cmd chrome-debug on Windows; legacy entry points
 * (chrome-debug.sh, start-chrome-debug.sh, start-chrome.ps1) translate their
 * old flags and delegate here.
 *
 * SECURITY: never add --remote-allow-origins=* or --ignore-certificate-errors.
 * SECURITY: never `source` .env — values are parsed as literal KEY=VALUE.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT_DIR = __dirname;
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const ENGINE_FILE = __filename;

// ── Safe .env loading (literal KEY=VALUE, never `source`) ───────────────────
const _envWarned = new Set();
function loadEnvFile(file) {
    if (!fs.existsSync(file)) return;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return; }
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 1) continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
        if (/^(PATH|PYTHONPATH|LD_PRELOAD|LD_LIBRARY_PATH|PYTHONSTARTUP|BASH_ENV|PROMPT_COMMAND)$/.test(key)) {
            if (!_envWarned.has(key)) {
                _envWarned.add(key);
                console.error(`[WARN] .env: blocked dangerous key '${key}'`);
            }
            continue;
        }
        if (process.env[key] === undefined) process.env[key] = value;
    }
}
function loadProjectEnv() {
    loadEnvFile(path.join(os.homedir(), '.env'));
    loadEnvFile(path.join(PROJECT_ROOT, '.env'));
}

// ── Platform adapter selection ──────────────────────────────────────────────
let adapter;
function getAdapter() {
    if (adapter) return adapter;
    if (process.platform === 'win32') {
        adapter = require('./win32-lifecycle-adapter.cjs');
    } else {
        adapter = require('./posix-lifecycle-adapter.cjs');
    }
    return adapter;
}

// ── Config resolution ───────────────────────────────────────────────────────
function expandHome(p) {
    if (!p) return p;
    if (p === '~') return os.homedir();
    if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
    return p;
}

function resolveProfile(env) {
    const e = env || process.env;
    if (e.CHROME_PROFILE) return { dir: path.resolve(expandHome(e.CHROME_PROFILE)), source: 'CHROME_PROFILE' };
    if (e.CHROME_DEBUG_PROFILE) return { dir: path.resolve(expandHome(e.CHROME_DEBUG_PROFILE)), source: 'CHROME_DEBUG_PROFILE' };
    return { dir: null, source: 'default' };
}

function resolvePort(env) {
    const e = env || process.env;
    if (e.CDP_PORT) return { port: String(e.CDP_PORT).trim(), source: 'CDP_PORT' };
    if (e.CHROME_DEBUG_PORT) return { port: String(e.CHROME_DEBUG_PORT).trim(), source: 'CHROME_DEBUG_PORT' };
    return { port: '9222', source: 'default' };
}

function isHeadlessTruthy(v) {
    return /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());
}

function headlessAuto() {
    if (process.platform === 'darwin') return false;
    return !process.env.DISPLAY;
}

function resolveHeadless(env) {
    const e = env || process.env;
    if (e.CHROME_DEBUG_HEADLESS === '1') return { headless: true, source: 'CHROME_DEBUG_HEADLESS=1' };
    if (e.CHROME_DEBUG_HEADLESS === '0') return { headless: false, source: 'CHROME_DEBUG_HEADLESS=0' };
    if (e.HEADLESS !== undefined && e.HEADLESS !== '') {
        return { headless: isHeadlessTruthy(e.HEADLESS), source: `HEADLESS=${e.HEADLESS}` };
    }
    if (e.CHROME_DEBUG_HEADLESS !== undefined && e.CHROME_DEBUG_HEADLESS !== '') {
        return { headless: isHeadlessTruthy(e.CHROME_DEBUG_HEADLESS), source: `CHROME_DEBUG_HEADLESS=${e.CHROME_DEBUG_HEADLESS}` };
    }
    return { headless: headlessAuto(), source: 'auto' };
}

function defaultUserDataDirFor(chromeBin) {
    const h = os.homedir();
    if (process.platform === 'darwin') {
        if (String(chromeBin).includes('Canary')) return path.join(h, 'Library', 'Application Support', 'Google', 'Chrome Canary');
        if (String(chromeBin).endsWith('/Chromium')) return path.join(h, 'Library', 'Application Support', 'Chromium');
        return path.join(h, 'Library', 'Application Support', 'Google', 'Chrome');
    }
    const xdg = process.env.XDG_CONFIG_HOME || path.join(h, '.config');
    const base = String(chromeBin).toLowerCase();
    if (base.includes('chromium')) return path.join(xdg, 'chromium');
    return path.join(xdg, 'google-chrome');
}

function defaultCloneDir() {
    const h = os.homedir();
    if (process.platform === 'darwin') return path.join(h, 'Library', 'Application Support', 'Google', 'chrome-debug-profile-from-default');
    const xdg = process.env.XDG_CONFIG_HOME || path.join(h, '.config');
    return path.join(xdg, 'Google', 'chrome-debug-profile-from-default');
}

function dedicatedProfileDir() {
    const h = os.homedir();
    if (process.platform === 'darwin') return path.join(h, 'Library', 'Application Support', 'Google', 'chrome-debug-profile');
    const xdg = process.env.XDG_CONFIG_HOME || path.join(h, '.config');
    return path.join(xdg, 'Google', 'chrome-debug-profile');
}

function repoLocalProfileDir(projectRoot) {
    return path.join(projectRoot || PROJECT_ROOT, '.chrome-debug-profile');
}

/** Resolve the full engine configuration. Pure-ish; env injectable for tests. */
function resolveConfig(cliFlags, env) {
    const e = env || process.env;
    const flags = cliFlags || {};
    const profile = resolveProfile(e);
    const portRes = resolvePort(e);
    const port = portRes.port;

    let mode = flags.profileMode || e.CHROME_DEBUG_PROFILE_MODE || 'default-user';
    let profileDir = profile.dir;
    let profileLabel = profile.source === 'default' ? '' : `custom profile path from ${profile.source}`;
    let profileSourceDir = '';
    let profileDirectoryName = flags.profileDirectory || e.CHROME_DEBUG_PROFILE_DIRECTORY || 'Default';
    let refreshFromDefault = !!(flags.refreshFromDefault || isHeadlessTruthy(e.CHROME_DEBUG_REFRESH_FROM_DEFAULT));

    if (!profileDir) {
        switch (mode) {
            case 'repo-local':
                profileDir = repoLocalProfileDir(flags.projectRoot || e.CHROME_DEBUG_PROJECT_ROOT);
                profileLabel = 'repo-local debug profile';
                break;
            case 'dedicated':
                profileDir = dedicatedProfileDir();
                profileLabel = 'dedicated debug profile';
                break;
            case 'default-user':
            default:
                mode = 'default-user';
                profileDir = defaultCloneDir();
                profileLabel = `clone of Chrome user-data directory (${profileDirectoryName})`;
                profileSourceDir = defaultUserDataDirFor(flags.chromeBin || e.CHROME || e.CHROMIUM_PATH || '');
                break;
        }
    }

    let headlessRes;
    if (flags.headless !== undefined) {
        headlessRes = { headless: !!flags.headless, source: 'CLI --headless/--headed' };
    } else {
        headlessRes = resolveHeadless(e);
    }
    const targetUrl = flags.url || e.CHROME_DEBUG_URL || (flags.firstLogin ? (e.GEMINI_URL || 'https://gemini.google.com/u/0/app') : 'about:blank');
    const logFile = e.CHROME_DEBUG_LOG || path.join(flags.projectRoot || PROJECT_ROOT, 'logs', 'chrome-debug.log');
    const stateDir = e.CHROME_DEBUG_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'agentchat');

    return {
        chromeBin: flags.chromeBin || e.CHROME || e.CHROMIUM_PATH || null,
        debugPort: port,
        portSource: portRes.source,
        profileMode: mode,
        profileDir,
        profileLabel,
        profileDirectoryName,
        profileSourceDir,
        profileSource: profile.source,
        refreshFromDefault,
        headless: headlessRes.headless,
        headlessSource: headlessRes.source,
        targetUrl,
        logFile,
        stateDir,
        projectRoot: flags.projectRoot || PROJECT_ROOT,
        proxyServer: e.PROXY_SERVER || '',
        json: !!(flags.json || e.CHROME_DEBUG_JSON === '1'),
    };
}

// ── State record ────────────────────────────────────────────────────────────
function stateKey(profileDir, port) {
    const norm = String(profileDir).replace(/[\\/]+$/, '').toLowerCase();
    return crypto.createHash('sha256').update(`${norm}\u0000${port}`).digest('hex').slice(0, 16);
}
function statePaths(cfg) {
    const key = stateKey(cfg.profileDir, cfg.debugPort);
    return {
        key,
        stateFile: path.join(cfg.stateDir, `chrome-debug-${key}.json`),
        stopMarker: path.join(cfg.stateDir, `chrome-debug-${key}.stop`),
    };
}

function readStateRaw(paths) {
    try {
        return JSON.parse(fs.readFileSync(paths.stateFile, 'utf8'));
    } catch (_) {
        return null;
    }
}

function writeStateAtomically(paths, state) {
    fs.mkdirSync(path.dirname(paths.stateFile), { recursive: true });
    const tmp = paths.stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, paths.stateFile);
}

function clearState(paths) {
    try { fs.rmSync(paths.stateFile, { force: true }); } catch (_) {}
    try { fs.rmSync(paths.stopMarker, { force: true }); } catch (_) {}
}

/** Validate that a live process at pid is really the engine's supervisor. */
function validateSupervisor(pid, cfg, paths) {
    const a = getAdapter();
    if (!a.isProcessAlive(pid)) return { ok: false, reason: 'supervisor not alive' };
    const ident = a.processIdentity(pid);
    if (!ident) return { ok: false, reason: 'cannot read supervisor identity' };
    const cmd = ident.command || '';
    // The supervisor is either the detached `--supervise` process or the
    // `--daemon --foreground` process running the same loop in-process.
    // Profile/port live in argv for the detached form and in env for the
    // foreground form, so ownership is proven by PID + start identity
    // (checked by validateState) rather than by argv contents.
    const isEngine = cmd.includes('chrome-debug-lifecycle');
    const isSupervising = cmd.includes('--supervise') || (cmd.includes('--daemon') && cmd.includes('--foreground'));
    if (!isEngine || !isSupervising) {
        return { ok: false, reason: 'PID is not the AgentChat Chrome supervisor' };
    }
    return { ok: true, identity: ident };
}

/** Validate a state record: matching scope, live supervisor, live child. */
function validateState(record, cfg, paths) {
    if (!record) return { ok: false, reason: 'no state record', record: null };
    if (record.schemaVersion !== 1) return { ok: false, reason: `unknown schema version ${record.schemaVersion}`, record };
    if (record.stateKey !== paths.key) return { ok: false, reason: 'record state key mismatch', record };
    if (String(record.profile) !== String(cfg.profileDir)) return { ok: false, reason: 'record profile mismatch', record };
    if (String(record.port) !== String(cfg.debugPort)) return { ok: false, reason: 'record port mismatch', record };
    const sup = validateSupervisor(record.supervisorPid, cfg, paths);
    if (!sup.ok) return { ok: false, reason: sup.reason, record };
    if (record.supervisorStart !== sup.identity.startTime) {
        return { ok: false, reason: 'supervisor start identity mismatch (PID reuse?)', record };
    }
    const a = getAdapter();
    if (!a.isProcessAlive(record.chromePid)) return { ok: false, reason: 'recorded Chrome not alive', record };
    return { ok: true, record };
}

/** Validate only the supervisor side of a record (stop can run while the
 *  child is dead — e.g. the supervisor is in crash backoff). */
function validateSupervisorSide(record, cfg, paths) {
    if (!record) return { ok: false, reason: 'no state record' };
    if (record.stateKey !== paths.key) return { ok: false, reason: 'record state key mismatch' };
    if (String(record.profile) !== String(cfg.profileDir)) return { ok: false, reason: 'record profile mismatch' };
    if (String(record.port) !== String(cfg.debugPort)) return { ok: false, reason: 'record port mismatch' };
    const sup = validateSupervisor(record.supervisorPid, cfg, paths);
    if (!sup.ok) return { ok: false, reason: sup.reason };
    if (record.supervisorStart !== sup.identity.startTime) {
        return { ok: false, reason: 'supervisor start identity mismatch (PID reuse?)' };
    }
    return { ok: true, record };
}

// ── Diagnostics / port / process helpers ────────────────────────────────────
function probePort(port, timeoutMs = 1500) {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port: Number(port), path: '/json/version', timeout: timeoutMs }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode === 200));
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function profileProcessPids(cfg) {
    const a = getAdapter();
    const marker = `--user-data-dir=${cfg.profileDir}`;
    const markerNorm = marker.toLowerCase();
    const pids = [];
    if (process.platform === 'win32') {
        try {
            const { execFileSync } = require('child_process');
            const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\' OR Name=\'msedge.exe\' OR Name=\'chromium.exe\'" | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }';
            const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 10_000, encoding: 'utf8', windowsHide: true });
            for (const line of out.split(/\r?\n/)) {
                const i = line.indexOf('\t');
                if (i < 1) continue;
                const pid = parseInt(line.slice(0, i), 10);
                const cmd = line.slice(i + 1);
                if (cmd && cmd.toLowerCase().includes(markerNorm)) pids.push(pid);
            }
        } catch (_) {}
        return pids;
    }
    try {
        const { execFileSync } = require('child_process');
        const out = execFileSync('ps', ['-ax', '-o', 'pid=', '-o', 'command='], { encoding: 'utf8', timeout: 5000 });
        for (const line of out.split(/\r?\n/)) {
            const m = line.match(/^\s*(\d+)\s+(.*)$/);
            if (!m) continue;
            if (m[2].toLowerCase().includes(markerNorm)) pids.push(Number(m[1]));
        }
    } catch (_) {}
    return pids;
}

// ── Chrome arg building (single source of truth) ────────────────────────────
function buildChromeArgs(cfg) {
    const args = [
        '--no-first-run',
        '--no-default-browser-check',
        `--remote-debugging-port=${cfg.debugPort}`,
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${cfg.profileDir}`,
        '--disable-session-crashed-bubble',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--disable-infobars',
        '--disable-features=ChromeWhatsNewUI,AutofillServerCommunication,AutomationControlled',
        '--start-maximized',
        '--window-position=0,0',
        '--window-size=1920,1080',
        cfg.targetUrl,
    ];
    if (cfg.proxyServer) args.push(`--proxy-server=${cfg.proxyServer}`);
    args.push(
        '--disable-blink-features=AutomationControlled',
        '--disable-background-networking',
        '--disable-client-side-phishing-detection',
        '--disable-component-update',
        '--disable-field-trial-config',
        '--disable-hang-monitor',
        '--disable-popup-blocking',
        '--disable-renderer-backgrounding',
        '--noerrdialogs',
        '--hide-scrollbars',
        '--mute-audio',
        '--disable-breakpad',
        '--disable-quic',
        '--proxy-bypass-list=<-loopback>',
    );
    if (cfg.profileMode === 'default-user') {
        args.unshift(`--profile-directory=${cfg.profileDirectoryName}`);
    }
    if (cfg.headless) {
        args.unshift('--headless=new');
    }
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
        args.push('--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-software-rasterizer', '--password-store=basic');
    }
    return args;
}

// ── Profile preparation ─────────────────────────────────────────────────────
function syncDefaultUserProfile(cfg, log) {
    if (!cfg.profileSourceDir) {
        log('[ERROR] Default-user mode is missing the source Chrome profile directory.');
        process.exitCode = 1;
        throw new Error('missing profile source dir');
    }
    const src = path.join(cfg.profileSourceDir, cfg.profileDirectoryName);
    const dst = path.join(cfg.profileDir, cfg.profileDirectoryName);
    if (!fs.existsSync(src)) {
        throw new Error(`Chrome profile directory does not exist: ${src}`);
    }
    fs.mkdirSync(cfg.profileDir, { recursive: true });
    log(`[INFO] Syncing Chrome profile ${cfg.profileDirectoryName} from ${cfg.profileSourceDir} into ${cfg.profileDir}.`);
    fs.rmSync(dst, { recursive: true, force: true });
    if (process.platform === 'win32') {
        const { execFileSync } = require('child_process');
        try {
            const ps = `Copy-Item -Path ${JSON.stringify(src)} -Destination ${JSON.stringify(cfg.profileDir)} -Recurse -Force; ` +
                       `@('Cache','Code Cache','GPUCache','GrShaderCache','ShaderCache','Crashpad') | ForEach-Object { Remove-Item -Path (Join-Path ${JSON.stringify(dst)} $_) -Recurse -Force -ErrorAction SilentlyContinue }; ` +
                       `Remove-Item -Path (Join-Path ${JSON.stringify(cfg.profileDir)} 'Local State') -Force -ErrorAction SilentlyContinue; ` +
                       `Copy-Item -Path ${JSON.stringify(path.join(cfg.profileSourceDir, 'Local State'))} -Destination ${JSON.stringify(cfg.profileDir)} -Force -ErrorAction SilentlyContinue`;
            execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 120_000, stdio: 'ignore', windowsHide: true });
        } catch (e) {
            throw new Error(`profile sync failed: ${e.message}`);
        }
        return;
    }
    const { execFileSync } = require('child_process');
    try {
        execFileSync('rsync', ['-a', '--delete',
            '--exclude=Cache/', '--exclude=Code Cache/', '--exclude=GPUCache/', '--exclude=GrShaderCache/',
            '--exclude=ShaderCache/', '--exclude=Crashpad/', '--exclude=Singleton*',
            path.join(src, path.sep), path.join(dst, path.sep)],
            { timeout: 120_000, stdio: 'ignore' });
    } catch (_) {
        fs.cpSync(src, dst, { recursive: true, force: true });
        for (const d of ['Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache', 'Crashpad']) {
            fs.rmSync(path.join(dst, d), { recursive: true, force: true });
        }
        for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
            fs.rmSync(path.join(dst, f), { force: true });
        }
    }
    fs.rmSync(path.join(cfg.profileDir, 'Local State'), { force: true });
    try {
        fs.copyFileSync(path.join(cfg.profileSourceDir, 'Local State'), path.join(cfg.profileDir, 'Local State'));
    } catch (_) {}
}

function seedProfilePreferences(cfg) {
    const defaultDir = path.join(cfg.profileDir, 'Default');
    const prefs = path.join(defaultDir, 'Preferences');
    if (fs.existsSync(prefs)) return;
    fs.mkdirSync(defaultDir, { recursive: true });
    fs.writeFileSync(prefs, JSON.stringify({
        session: { restore_on_startup: 5 },
        profile: { exit_type: 'Normal' },
        browser: { has_seen_welcome_page: true },
    }, null, 2));
}

function cleanSingletonLocks(cfg) {
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'Lockfile']) {
        try { fs.rmSync(path.join(cfg.profileDir, f), { force: true }); } catch (_) {}
    }
}

function prepareProfile(cfg, log) {
    fs.mkdirSync(path.dirname(cfg.logFile), { recursive: true });
    fs.mkdirSync(cfg.profileDir, { recursive: true });
    if (cfg.profileMode === 'default-user') {
        if (cfg.refreshFromDefault || !fs.existsSync(path.join(cfg.profileDir, cfg.profileDirectoryName))) {
            if (profileProcessPids(cfg).length > 0) {
                throw new Error('Chrome is already running for this profile — close it before syncing the default-user clone');
            }
            syncDefaultUserProfile(cfg, log);
        }
    } else {
        seedProfilePreferences(cfg);
    }
    cleanSingletonLocks(cfg);
}

// ── Chrome binary validation ────────────────────────────────────────────────
function validateChromeBinary(bin) {
    if (!bin) return { ok: false, reason: 'Chrome/Chromium binary not found — set CHROME or CHROMIUM_PATH in .env' };
    if (String(bin).includes('.cache/ms-playwright') || String(bin).includes('ms-playwright')) {
        return { ok: false, reason: `REFUSING Playwright Chromium (no login state): ${bin}` };
    }
    const ex = path.resolve(expandHome(bin));
    if (!fs.existsSync(ex)) {
        return { ok: false, reason: `Chrome binary not found: ${ex}` };
    }
    return { ok: true, bin: ex };
}

// ── Output helpers ──────────────────────────────────────────────────────────
function logInfo(cfg, msg) { if (!cfg.json) console.log(msg); }
function logError(cfg, msg) { console.error(msg); }

function printConfig(cfg, extra = {}) {
    const payload = {
        chromeBin: cfg.chromeBin || '<unresolved>',
        debugPort: Number(cfg.debugPort),
        portSource: cfg.portSource,
        profileDir: cfg.profileDir,
        profileMode: cfg.profileMode,
        profileLabel: cfg.profileLabel,
        profileDirectory: cfg.profileDirectoryName,
        profileSourceDir: cfg.profileSourceDir || '',
        profileSource: cfg.profileSource,
        refreshFromDefault: !!cfg.refreshFromDefault,
        headless: !!cfg.headless,
        headlessSource: cfg.headlessSource,
        logFile: cfg.logFile,
        targetUrl: cfg.targetUrl,
        proxyServer: cfg.proxyServer,
        projectRoot: cfg.projectRoot,
        launchArgs: extra.launchArgs || [],
        chromeDebugContract: 'v3',
    };
    if (cfg.json) {
        console.log(JSON.stringify(payload, null, 2));
    } else {
        for (const [k, v] of Object.entries(payload)) {
            if (Array.isArray(v)) continue;
            console.log(`${k.toUpperCase()}=${v}`);
        }
        console.log('CHROME_DEBUG_CONTRACT=v3');
    }
}

// ── Launch: one-shot detached / daemon parent / supervisor ──────────────────
async function waitForPort(cfg, timeoutMs = 60_000, log) {
    const start = Date.now();
    let dots = 0;
    if (!cfg.json) process.stdout.write(`[INFO] Waiting for debugger on port ${cfg.debugPort}`);
    while (Date.now() - start < timeoutMs) {
        if (await probePort(cfg.debugPort)) {
            await sleep(250);
            if (await probePort(cfg.debugPort)) {
                if (!cfg.json) console.log('');
                return true;
            }
        }
        if (!cfg.json && dots < 80) { process.stdout.write('.'); dots++; }
        await sleep(500);
    }
    if (!cfg.json) console.log('');
    return false;
}

function spawnChrome(cfg, mode) {
    const a = getAdapter();
    const args = buildChromeArgs(cfg);
    if (mode === 'supervisor') {
        // Supervisor spawns Chrome as a direct child so it observes the exit.
        const child = spawn(cfg.chromeBin, args, { stdio: 'ignore' });
        return { pid: child.pid, child };
    }
    const pid = a.spawnDetached(cfg.chromeBin, args, { env: process.env });
    return { pid };
}

/** Supervisor loop: own the Chrome child; clean exit ends, crash restarts. */
async function runSupervisor(cfg) {
    const paths = statePaths(cfg);
    const log = (m) => { if (!cfg.json) console.log(m); };
    const a = getAdapter();
    let stopRequested = false;
    const requestStop = () => { stopRequested = true; };
    process.on('SIGTERM', requestStop);
    process.on('SIGINT', requestStop);

    const maxRestarts = Number(process.env.CHROME_DEBUG_MAX_RESTARTS || 5);
    const backoffBase = Number(process.env.CHROME_DEBUG_BACKOFF_BASE_MS || 2000);
    let crashCount = 0;

    clearState(paths);

    // Sleep that aborts early when a stop was requested or marked.
    const stopAwareSleep = async (ms) => {
        let waited = 0;
        while (waited < ms && !stopRequested && !fs.existsSync(paths.stopMarker)) {
            await sleep(100);
            waited += 100;
        }
    };

    while (!stopRequested) {
        if (fs.existsSync(paths.stopMarker)) { stopRequested = true; break; }
        let child;
        try {
            const spawned = spawnChrome(cfg, 'supervisor');
            child = spawned.child;
        } catch (e) {
            log(`[ERROR] Failed to spawn Chrome ${cfg.chromeBin}: ${e.message}`);
            clearState(paths);
            return 1;
        }
        child.on('error', (e) => {
            log(`[ERROR] Chrome spawn error: ${e.message}`);
        });
        const pid = child.pid;
        const chromeStart = a.processIdentity(pid);
        const state = {
            schemaVersion: 1,
            command: 'chrome-debug',
            mode: 'daemon',
            lifecycle: 'supervising',
            supervisorPid: process.pid,
            supervisorStart: (a.processIdentity(process.pid) || {}).startTime || '',
            chromePid: pid,
            chromeStart: (chromeStart || {}).startTime || '',
            profile: cfg.profileDir,
            port: cfg.debugPort,
            stateKey: paths.key,
        };
        writeStateAtomically(paths, state);
        log(`[OK] Supervisor ${process.pid} owns Chrome ${pid} on port ${cfg.debugPort}.`);

        // Wait for the child to exit or a stop request. Polling instead of a
        // bare 'exit' listener keeps the stop-marker check responsive.
        let outcome = null;
        while (!outcome && !stopRequested) {
            if (fs.existsSync(paths.stopMarker)) { stopRequested = true; break; }
            if (child.exitCode !== null || child.signalCode !== null) {
                outcome = { code: child.exitCode, signal: child.signalCode };
                break;
            }
            await sleep(200);
        }
        if (stopRequested) {
            if (child && child.exitCode === null) {
                try { a.terminateTree(child.pid, { log }); } catch (_) {}
            }
            break;
        }

        const clean = outcome.code === 0 && !outcome.signal;
        if (clean) {
            log('[INFO] Chrome exited cleanly; supervision ends (no restart).');
            break;
        }

        crashCount += 1;
        log(`[WARN] Chrome exited abnormally (${outcome.signal ? 'signal ' + outcome.signal : 'exit ' + outcome.code}) — crash ${crashCount}/${maxRestarts}.`);
        if (crashCount >= maxRestarts) {
            log(`[ERROR] Max restarts (${maxRestarts}) reached; giving up.`);
            break;
        }
        const backoff = Math.min(backoffBase * Math.pow(2, crashCount - 1), 30_000);
        log(`[INFO] Restarting Chrome in ${Math.round(backoff / 1000)}s (attempt ${crashCount + 1}/${maxRestarts})...`);
        await stopAwareSleep(backoff);
    }

    if (stopRequested) {
        log('[INFO] Stop requested; clearing ownership state.');
    }
    clearState(paths);
    return 0;
}

function spawnSupervisorDetached(cfg) {
    const a = getAdapter();
    const key = statePaths(cfg).key;
    const argv = [ENGINE_FILE, '--supervise', '--state-dir', cfg.stateDir, '--profile', cfg.profileDir, '--port', cfg.debugPort];
    const logFile = path.join(cfg.stateDir, `chrome-debug-${key}.supervisor.log`);
    const pid = a.spawnSupervisor(process.execPath, argv, process.env, logFile);
    return pid;
}

// ── CLI commands ────────────────────────────────────────────────────────────
async function cmdStatus(cfg) {
    const paths = statePaths(cfg);
    const portUp = await probePort(cfg.debugPort);
    const record = readStateRaw(paths);
    const validated = record ? validateState(record, cfg, paths) : { ok: false, reason: 'no state record' };
    const profilePids = profileProcessPids(cfg);
    const status = {
        debugPort: Number(cfg.debugPort),
        portUp,
        profileDir: cfg.profileDir,
        profileSource: cfg.profileSource,
        profileMode: cfg.profileMode,
        headless: !!cfg.headless,
        headlessSource: cfg.headlessSource,
        chromeRunningForProfile: profilePids.length > 0,
        ownership: validated.ok
            ? { state: 'owned', supervisorPid: validated.record.supervisorPid, chromePid: validated.record.chromePid, lifecycle: validated.record.lifecycle }
            : { state: 'unowned', reason: validated.reason },
    };
    if (cfg.json) {
        console.log(JSON.stringify(status, null, 2));
    } else {
        console.log(`Debug port   : ${cfg.debugPort} (${portUp ? 'serving CDP' : 'free'}, source ${cfg.portSource})`);
        console.log(`Profile      : ${cfg.profileDir} (source ${cfg.profileSource}, mode ${cfg.profileMode})`);
        console.log(`Headless     : ${cfg.headless ? 'yes' : 'no'} (${cfg.headlessSource})`);
        console.log(`Chrome alive : ${profilePids.length > 0 ? `yes (${profilePids.join(', ')})` : 'no'}`);
        if (validated.ok) {
            console.log(`Ownership    : supervisor ${validated.record.supervisorPid} owns Chrome ${validated.record.chromePid}`);
        } else {
            console.log(`Ownership    : ${validated.reason}`);
        }
    }
    return 0;
}

async function cmdStop(cfg) {
    const paths = statePaths(cfg);
    const record = readStateRaw(paths);
    if (!record) {
        logInfo(cfg, '[INFO] No ownership state — nothing to stop.');
        return 0;
    }
    // Stop validates the SUPERVISOR side only: the child may be dead while
    // the supervisor is in crash backoff, and stopping must still reach it.
    // (Full child-liveness is a --status invariant, not a stop precondition.)
    const validated = validateSupervisorSide(record, cfg, paths);
    if (!validated.ok) {
        logInfo(cfg, `[INFO] No validated ownership (${validated.reason}) — stale state cleared, nothing killed.`);
        clearState(paths);
        return 0;
    }
    const a = getAdapter();
    const supPid = validated.record.supervisorPid;
    logInfo(cfg, `[INFO] Stopping owned supervisor ${supPid} (Chrome ${record.chromePid}).`);
    // Write the stop intent BEFORE signaling: the supervisor checks the
    // marker even during backoff sleeps, and a requested stop must never be
    // classified as a crash.
    fs.writeFileSync(paths.stopMarker, new Date().toISOString());
    try { process.kill(supPid, 'SIGTERM'); } catch (_) {}
    // Wait for the supervisor to clear state (clean path), then escalate only ours.
    let waited = 0;
    while (waited < 10_000) {
        if (!fs.existsSync(paths.stateFile)) {
            logInfo(cfg, '[OK] Supervisor cleared ownership state.');
            return 0;
        }
        await sleep(200);
        waited += 200;
    }
    const still = validateSupervisor(supPid, cfg, paths);
    if (still.ok) {
        logInfo(cfg, `[WARN] Supervisor did not exit cleanly — escalating owned tree (PID ${supPid}).`);
        a.terminateTree(supPid, { log: (m) => logInfo(cfg, m) });
    }
    await sleep(500);
    if (fs.existsSync(paths.stateFile)) clearState(paths);
    logInfo(cfg, '[OK] Stop complete.');
    return 0;
}

async function cmdLaunch(cfg, opts = {}) {
    const log = (m) => logInfo(cfg, m);
    if (!cfg.chromeBin) {
        logError(cfg, '[ERROR] Chrome/Chromium binary not found.');
        logError(cfg, '[ERROR] Set CHROME or CHROMIUM_PATH in .env to a valid binary path.');
        return 1;
    }
    const binCheck = validateChromeBinary(cfg.chromeBin);
    if (!binCheck.ok) {
        logError(cfg, `[ERROR] ${binCheck.reason}`);
        return 1;
    }
    cfg.chromeBin = binCheck.bin;

    const paths = statePaths(cfg);
    // Drop stale state from a dead supervisor before doing anything.
    const stale = readStateRaw(paths);
    if (stale && !validateState(stale, cfg, paths).ok) clearState(paths);

    if (opts.daemon) {
        const already = readStateRaw(paths);
        if (already) {
            const v = validateState(already, cfg, paths);
            if (v.ok) {
                log(`[OK] Supervisor ${v.record.supervisorPid} already owns Chrome ${v.record.chromePid} on port ${cfg.debugPort}.`);
                return 0;
            }
            clearState(paths);
        }
    }

    if (await probePort(cfg.debugPort)) {
        const profilePids = profileProcessPids(cfg);
        if (profilePids.length > 0) {
            log(`[OK] Found existing debug Chrome instance on port ${cfg.debugPort}; reusing profile ${cfg.profileDir}.`);
            return 0;
        }
        logError(cfg, `[ERROR] Port ${cfg.debugPort} is already serving DevTools for a different Chrome instance.`);
        logError(cfg, '[ERROR] Stop the other debugger Chrome or set CDP_PORT to a different port.');
        return 1;
    }

    try {
        prepareProfile(cfg, log);
    } catch (e) {
        logError(cfg, `[ERROR] ${e.message}`);
        return 1;
    }

    if (opts.daemon) {
        const supPid = spawnSupervisorDetached(cfg);
        log(`[INFO] Daemon supervisor spawned (PID ${supPid}).`);
        let waited = 0;
        while (waited < 45_000) {
            const rec = readStateRaw(paths);
            if (rec) {
                const v = validateState(rec, cfg, paths);
                if (v.ok) {
                    log(`[OK] Chrome CDP on port ${cfg.debugPort} supervised by PID ${supPid}.`);
                    return 0;
                }
            }
            await sleep(500);
            waited += 500;
        }
        logError(cfg, `[ERROR] Supervisor did not establish ownership within 45s (log: ${path.join(cfg.stateDir, `chrome-debug-${paths.key}.supervisor.log`)}).`);
        return 1;
    }

    // One-shot: detached launch, wait for the port, no ownership record.
    log(`[INFO] Starting Chrome in detached mode.`);
    log(`[INFO] Chrome: ${cfg.chromeBin}`);
    log(`[INFO] Port: ${cfg.debugPort}`);
    log(`[INFO] Profile mode: ${cfg.profileMode}`);
    log(`[INFO] Profile: ${cfg.profileDir}`);
    if (cfg.profileSourceDir) log(`[INFO] Profile source: ${cfg.profileSourceDir}`);
    log(`[INFO] Headless: ${cfg.headless ? 'yes' : 'no'} (${cfg.headlessSource})`);
    log(`[INFO] URL: ${cfg.targetUrl}`);
    log(`[INFO] Log file: ${cfg.logFile}`);
    log(`[INFO] State dir: ${cfg.stateDir}`);

    const { pid } = spawnChrome(cfg, 'detached');
    log(`[INFO] Chrome launched detached (PID ${pid}).`);

    const ok = await waitForPort(cfg, 60_000, log);
    if (!ok) {
        logError(cfg, `[ERROR] Chrome started but port ${cfg.debugPort} is not responsive.`);
        logError(cfg, `[ERROR] Check logs at ${cfg.logFile}`);
        return 1;
    }
    log(`[OK] Chrome is listening on port ${cfg.debugPort}.`);
    return 0;
}

// ── Argument parsing ────────────────────────────────────────────────────────
function parseArgs(argv) {
    const flags = {};
    const positional = [];
    let i = 0;
    while (i < argv.length) {
        const arg = argv[i];
        switch (arg) {
            case '--dry-run': flags.dryRun = true; break;
            case '--print-config': flags.printConfig = true; break;
            case '--json': flags.json = true; break;
            case '--check-port': flags.checkPort = true; break;
            case '--explain': flags.explain = true; break;
            case '--launch-and-explain': flags.launchAndExplain = true; break;
            case '--restart': flags.restart = true; break;
            case '--daemon': flags.daemon = true; break;
            case '--foreground': flags.foreground = true; break;
            case '--supervise': flags.supervise = true; break;
            case '--stop': flags.stop = true; break;
            case '--status': flags.status = true; break;
            case '--default-user-profile': flags.profileMode = 'default-user'; break;
            case '--repo-local-profile': flags.profileMode = 'repo-local'; break;
            case '--dedicated-profile': flags.profileMode = 'dedicated'; break;
            case '--refresh-from-default': flags.refreshFromDefault = true; break;
            case '--headless': flags.headless = true; break;
            case '--headed': flags.headless = false; break;
            case '--first-login': flags.firstLogin = true; break;
            case '--profile-directory':
                i++;
                if (i >= argv.length) throw new Error('--profile-directory requires a value');
                flags.profileDirectory = argv[i];
                break;
            case '--url':
                i++;
                if (i >= argv.length) throw new Error('--url requires a value');
                flags.url = argv[i];
                break;
            case '--state-dir':
                i++;
                if (i >= argv.length) throw new Error('--state-dir requires a value');
                flags.stateDir = argv[i];
                break;
            case '--profile':
                i++;
                if (i >= argv.length) throw new Error('--profile requires a value');
                flags.profile = argv[i];
                break;
            case '--port':
                i++;
                if (i >= argv.length) throw new Error('--port requires a value');
                flags.port = argv[i];
                break;
            case '-h': case '--help':
                flags.help = true; break;
            case '--':
                i++;
                while (i < argv.length) { positional.push(argv[i]); i++; }
                break;
            default:
                if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
                positional.push(arg);
        }
        i++;
    }
    if (positional.length > 1) throw new Error(`Unexpected extra argument: ${positional[1]}`);
    if (positional.length === 1) flags.url = positional[0];
    return flags;
}

function printUsage() {
    console.log(`Usage: chrome-debug [options] [URL]

Options:
  --daemon            Start an owned supervisor (opt-in; restarts Chrome only on abnormal exit)
  --foreground        Run supervision in the foreground (testing/scripts; implies --daemon)
  --stop              Stop only the validated owned supervisor and its Chrome child
  --restart           Owned stop, then fresh start
  --status            Report port health, resolved config source, and ownership without changing processes
  --dry-run           Print the resolved launch configuration without starting Chrome
  --print-config      Print the resolved launch configuration before continuing
  --json              Emit diagnostics as JSON
  --check-port        Report whether the debug port is free or already in use
  --explain           Print a short diagnosis and suggested next action without launching
  --launch-and-explain  Print the diagnosis first, then continue with the normal launch flow
  --default-user-profile   Clone the normal Chrome profile into the debug-safe clone dir (default)
  --repo-local-profile     Use <project>/.chrome-debug-profile
  --dedicated-profile      Use the OS-native dedicated debug profile
  --refresh-from-default   Re-sync the default-user clone from the real Chrome profile before launch
  --profile-directory NAME Pick a Chrome profile subdirectory (Default, Profile 1, ...)
  --headless / --headed    Force headless / headed mode
  --url URL           Target URL (default: CHROME_DEBUG_URL or about:blank)
  --state-dir DIR     Ownership-state directory (internal: supervisor handoff)
  -h, --help          Show this help

Environment:
  CHROME_PROFILE            canonical user-data-dir (wins)
  CHROME_DEBUG_PROFILE      backward-compatible alias (fallback)
  CDP_PORT                  canonical debug port (wins)
  CHROME_DEBUG_PORT         backward-compatible port alias
  CHROME_DEBUG_PROFILE_MODE default-user | repo-local | dedicated
  CHROME_DEBUG_HEADLESS     0|1 (empty = auto: Linux headless when DISPLAY unset)
  HEADLESS                  1/true/yes legacy alias for CHROME_DEBUG_HEADLESS
  CHROME / CHROMIUM_PATH    Chrome/Chromium binary path
  PROXY_SERVER              HTTP/SOCKS5 proxy (from .env or env; empty = direct)
  CHROME_DEBUG_STATE_DIR    ownership-state directory (default ~/.local/state/agentchat; test override)
  CHROME_DEBUG_MAX_RESTARTS max abnormal-exit restarts (default 5)
  CHROME_DEBUG_BACKOFF_BASE_MS backoff base for crash restarts (default 2000)
  CHROME_DEBUG_LOG          launcher log path`);
}

// ── CLI entry ───────────────────────────────────────────────────────────────
async function runCli(argv, env) {
    const e = env || process.env;
    // Tests must be able to opt out of project .env loading entirely so their
    // controlled environment cannot be overridden by a repo .env.
    if (e.CHROME_DEBUG_ENV_SKIP !== '1') loadProjectEnv();
    let flags;
    try {
        flags = parseArgs(argv);
    } catch (err) {
        console.error(`[ERROR] ${err.message}`);
        printUsage();
        return 2;
    }
    if (flags.help) { printUsage(); return 0; }

    // Supervisor mode: args come from the parent via flags; build cfg directly.
    if (flags.supervise) {
        const supEnv = { ...e };
        if (flags.profile) supEnv.CHROME_PROFILE = flags.profile;
        if (flags.port) supEnv.CDP_PORT = flags.port;
        if (flags.stateDir) supEnv.CHROME_DEBUG_STATE_DIR = flags.stateDir;
        supEnv.CHROME_DEBUG_PROFILE_MODE = 'custom-path';
        const cfg = resolveConfig({}, supEnv);
        cfg.profileSource = 'supervisor';
        cfg.profileLabel = 'supervisor-owned';
        if (flags.json) cfg.json = true;
        return runSupervisor(cfg);
    }

    const cfg = resolveConfig(flags, e);
    if (flags.json) cfg.json = true;
    if (flags.stateDir) cfg.stateDir = flags.stateDir;

    // Resolve the Chrome binary once. Commands that never launch Chrome
    // (stop/status/check-port/explain) skip discovery entirely.
    const needsChrome = !flags.stop && !flags.status && !flags.checkPort && !flags.explain;
    if (needsChrome && (!cfg.chromeBin || !validateChromeBinary(cfg.chromeBin).ok)) {
        const discovered = getAdapter().discoverChrome();
        if (discovered) cfg.chromeBin = discovered;
    }

    if (flags.printConfig || flags.dryRun) {
        printConfig(cfg, { launchArgs: cfg.chromeBin ? buildChromeArgs(cfg) : [] });
        if (!cfg.json && !flags.dryRun) logInfo(cfg, '[INFO] Configuration printed; Chrome was not started.');
        return 0;
    }
    if (flags.checkPort) {
        const up = await probePort(cfg.debugPort);
        const profilePids = profileProcessPids(cfg);
        const status = up ? (profilePids.length ? 'owned_by_profile' : 'occupied_by_other') : 'free';
        if (cfg.json) console.log(JSON.stringify({ debugPort: Number(cfg.debugPort), status, profileDir: cfg.profileDir, profileMode: cfg.profileMode }));
        else if (status === 'free') logInfo(cfg, `[OK] Port ${cfg.debugPort} is free.`);
        else if (status === 'owned_by_profile') logInfo(cfg, `[OK] Port ${cfg.debugPort} is already serving DevTools for profile ${cfg.profileDir}.`);
        else logError(cfg, `[ERROR] Port ${cfg.debugPort} is serving DevTools for a different Chrome instance.`);
        return 0;
    }
    if (flags.explain || flags.launchAndExplain) {
        const up = await probePort(cfg.debugPort);
        const profilePids = profileProcessPids(cfg);
        if (cfg.json) {
            console.log(JSON.stringify({ debugPort: Number(cfg.debugPort), portUp: up, profilePids, profileDir: cfg.profileDir, profileMode: cfg.profileMode }));
        } else {
            if (!up) logInfo(cfg, `Port ${cfg.debugPort} is free; Chrome is not serving DevTools there. Run chrome-debug to start it.`);
            else if (profilePids.length) logInfo(cfg, `Port ${cfg.debugPort} is already owned by the configured ${cfg.profileLabel}. Reuse it or run with --restart.`);
            else logError(cfg, `Port ${cfg.debugPort} is occupied by a different DevTools-enabled Chrome instance. Stop it or change CDP_PORT.`);
        }
        if (flags.explain) return 0;
    }
    if (flags.status) return cmdStatus(cfg);
    if (flags.stop) return cmdStop(cfg);
    if (flags.restart) {
        const rc = await cmdStop(cfg);
        if (rc !== 0) return rc;
        if (!cfg.json) logInfo(cfg, '[INFO] Restart: previous instance stopped.');
    }

    if (flags.foreground) {
        // Foreground supervision: run the supervisor loop in this process
        // (used by tests and scripts that want to own the wait themselves).
        return runSupervisor(cfg);
    }
    // AGENTCHAT_CHROME_DAEMON=1 is the documented env opt-in for daemon
    // supervision (skill auto-start sets it; the flag is the CLI equivalent).
    return cmdLaunch(cfg, { daemon: !!flags.daemon || e.AGENTCHAT_CHROME_DAEMON === '1' });
}

if (require.main === module) {
    runCli(process.argv.slice(2)).then((code) => { process.exit(code); });
}

module.exports = {
    runCli, resolveConfig, buildChromeArgs, stateKey, statePaths, validateState,
    validateChromeBinary, probePort, profileProcessPids, prepareProfile,
    PROJECT_ROOT, ENGINE_FILE,
};
