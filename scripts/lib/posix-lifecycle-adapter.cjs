/**
 * POSIX (macOS/Linux) lifecycle primitives for the shared Chrome CDP engine.
 *
 * Everything here is a primitive the Node engine cannot express portably:
 * Chrome discovery, detached-session spawning, process identity inspection,
 * and owned-tree termination. No lifecycle policy lives in this file.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

function discoverChrome() {
    const candidates = [
        process.env.CHROME,
        process.env.CHROMIUM_PATH,
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    for (const c of candidates) {
        if (!c) continue;
        const ex = path.resolve(c);
        if (fs.existsSync(ex) && fs.statSync(ex).isFile()) return ex;
        // Treat CHROME/CHROMIUM_PATH as a PATH command too.
        if (!path.isAbsolute(c) && !c.includes(path.sep)) {
            try {
                const resolved = execFileSync('bash', ['-lc', `command -v -- ${JSON.stringify(c)} || true`], { encoding: 'utf8' }).trim();
                if (resolved) return resolved;
            } catch (_) {}
        }
    }
    if (process.platform === 'darwin') {
        // Puppeteer-downloaded "Chrome for Testing" fallback (same as the v2 script).
        try {
            const base = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
            const found = execFileSync('bash', ['-lc', `ls -d "${base}"/chrome-*/chrome-mac-*/Google\\ Chrome\\ for\\ Testing.app/Contents/MacOS/Google\\ Chrome\\ for\\ Testing 2>/dev/null | head -n 1 || true`], { encoding: 'utf8' }).trim();
            if (found && fs.existsSync(found)) return found;
        } catch (_) {}
    }
    for (const c of ['chromium-browser', 'chromium', 'google-chrome-unstable', 'google-chrome-stable', 'google-chrome', 'microsoft-edge']) {
        try {
            const resolved = execFileSync('bash', ['-lc', `command -v -- ${c} || true`], { encoding: 'utf8' }).trim();
            if (resolved) return resolved;
        } catch (_) {}
    }
    return null;
}

function isProcessAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
}

/** @returns {{pid:number, startTime:string, command:string}|null} */
function processIdentity(pid) {
    if (!pid) return null;
    try {
        const out = execFileSync('ps', ['-p', String(pid), '-o', 'pid=,lstart=,command='], { encoding: 'utf8', timeout: 5000 }).trim();
        if (!out) return null;
        const m = out.match(/^\s*(\d+)\s+(.*?)\s{2,}(.*)$/s);
        if (!m) return null;
        return { pid: Number(m[1]), startTime: m[2].trim(), command: m[3].trim() };
    } catch (_) {
        return null;
    }
}

/** Spawn detached into its own session (setsid / python3 os.setsid).
 *  Falls back to a plain detached spawn (own process group) when the
 *  session detach is denied (macOS sandboxes return EPERM for setsid). */
function spawnDetached(exe, args, opts = {}) {
    const spawnOpts = { detached: true, stdio: opts.stdio || ['ignore', 'ignore', 'ignore'] };
    if (opts.env) spawnOpts.env = opts.env;
    if (fs.existsSync('/usr/bin/setsid')) {
        // Linux `-f` forks before exec so setsid can become session leader;
        // other POSIX (rare) runs setsid directly.
        const argv = process.platform === 'linux' ? ['-f', exe, ...args] : [exe, ...args];
        const child = spawn('setsid', argv, spawnOpts);
        child.on('error', () => {});
        child.unref();
        return child.pid;
    }
    // macOS: python3 os.setsid() creates a new session like setsid. If that
    // call is denied (EPERM under sandboxed shells), the exec still proceeds
    // inside the process group Node created with detached: true.
    const py = [
        'import os,sys',
        'try: os.setsid()',
        'except OSError: pass',
        'os.execv(sys.argv[1], [sys.argv[1]] + sys.argv[2:])',
    ].join('\n');
    const child = spawn('python3', ['-c', py, exe, ...args], spawnOpts);
    child.on('error', () => {});
    child.unref();
    return child.pid;
}

/** Spawn the daemon supervisor detached (own session, log to file). */
function spawnSupervisor(nodeExe, argv, env, logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const out = fs.openSync(logFile, 'a');
    const err = fs.openSync(logFile, 'a');
    try {
        const child = spawn(nodeExe, argv, { detached: true, stdio: ['ignore', out, err], env });
        child.unref();
        return child.pid;
    } finally {
        fs.closeSync(out);
        fs.closeSync(err);
    }
}

/** Collect descendants of pid (children, recursively). */
function descendantPids(pid) {
    const seen = new Set();
    let frontier = [String(pid)];
    while (frontier.length) {
        try {
            const out = execFileSync('ps', ['-o', 'pid=', '--ppid', frontier.join(',')], { encoding: 'utf8', timeout: 5000 });
            const next = out.split(/\s+/).map(s => s.trim()).filter(Boolean);
            const fresh = next.filter(p => !seen.has(p) && Number(p) !== pid);
            for (const p of fresh) seen.add(p);
            frontier = fresh;
        } catch (_) {
            frontier = [];
        }
    }
    return [...seen].map(Number);
}

/** Graceful then forced stop of pid and its descendants (owned tree only). */
function terminateTree(pid, opts = {}) {
    const log = opts.log || (() => {});
    if (!isProcessAlive(pid)) return true;
    const all = [pid, ...descendantPids(pid)];
    for (const p of all) {
        try { process.kill(p, 'SIGTERM'); } catch (_) {}
    }
    let waited = 0;
    const graceMs = opts.graceMs || 4000;
    const stepMs = 100;
    while (waited < graceMs) {
        if (!all.some(p => isProcessAlive(p))) return true;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stepMs);
        waited += stepMs;
    }
    for (const p of all) {
        try { process.kill(p, 'SIGKILL'); } catch (_) {}
    }
    return !all.some(p => isProcessAlive(p));
}

module.exports = { discoverChrome, isProcessAlive, processIdentity, spawnDetached, spawnSupervisor, terminateTree };
