/**
 * Windows lifecycle primitives for the shared Chrome CDP engine.
 *
 * Windows-specific constraints handled here:
 *  - Chrome singleton is a named mutex, not Singleton* files.
 *  - Processes created via WMI (Win32_Process.Create) escape the caller's
 *    kill-on-close Job Object — plain spawn() dies with the tool call.
 *  - Chrome ≥136 ignores --remote-debugging-port on the vendor-default
 *    User Data dir, so discovery and defaults are explicit.
 *
 * No lifecycle policy lives in this file; the engine decides what to do.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/** CommandLineToArgvW-compatible quoting (backslash runs before quotes
 *  doubled, embedded quotes escaped). Mirrors skills/lib/cdp.js winArgQuote. */
function winArgQuote(a) {
    const s = String(a);
    if (s !== '' && !/[\s"]/.test(s)) return s;
    let out = '"';
    let bs = 0;
    for (const ch of s) {
        if (ch === '\\') { bs++; continue; }
        if (ch === '"') { out += '\\'.repeat(bs * 2 + 1) + '"'; bs = 0; continue; }
        out += '\\'.repeat(bs) + ch; bs = 0;
    }
    out += '\\'.repeat(bs * 2) + '"';
    return out;
}

function discoverChrome() {
    const candidates = [
        process.env.CHROME,
        process.env.CHROMIUM_PATH,
    ].filter(Boolean).map(p => path.resolve(p));
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const lad = process.env.LOCALAPPDATA || '';
    candidates.push(
        path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        lad && path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(pf, 'Chromium', 'Application', 'chrome.exe'),
        path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    );
    for (const c of candidates.filter(Boolean)) {
        if (fs.existsSync(c)) return c;
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
        // NOTE: plain string concat — PowerShell `t (backtick-t) must NOT go
        // through a JS template literal (backticks would be consumed).
        const ps = '$p = Get-CimInstance Win32_Process -Filter "ProcessId=' + pid + '" -ErrorAction SilentlyContinue; ' +
                   'if ($p) { "{0}`t{1}`t{2}" -f $p.ProcessId, $p.CreationDate.ToUniversalTime().ToString("o"), $p.CommandLine }';
        const out = execFileSync('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', ps],
            { timeout: 10_000, encoding: 'utf8', windowsHide: true }).trim();
        const [pidStr, startTime, ...rest] = out.split('\t');
        if (!pidStr || !startTime) return null;
        return { pid: Number(pidStr), startTime, command: rest.join('\t') };
    } catch (_) {
        return null;
    }
}

/** PowerShell one-liner: set a process env var (affects child created after). */
function setEnvPs(key, value) {
    const v = String(value == null ? '' : value).replace(/'/g, "''");
    return `[Environment]::SetEnvironmentVariable('${key.replace(/'/g, "''")}','${v}','Process'); `;
}

/** Build a PowerShell command that creates a process via WMI and prints its PID. */
function buildWmiCreateCommand(exe, args, envOverrides = {}) {
    const cmdline = [exe, ...args].map(winArgQuote).join(' ');
    const psLiteral = cmdline.replace(/'/g, "''");
    const envPs = Object.entries(envOverrides)
        .map(([k, v]) => setEnvPs(k, v))
        .join('');
    return envPs +
        `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${psLiteral}' }; ` +
        `if ($r.ReturnValue -eq 0) { [Console]::Out.Write($r.ProcessId) } ` +
        `else { [Console]::Error.Write('ReturnValue=' + $r.ReturnValue); exit 1 }`;
}

function execWmi(psCommand) {
    const out = execFileSync('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand],
        { timeout: 20_000, encoding: 'utf8', windowsHide: true });
    const pid = parseInt(String(out).trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/** Engine-relevant env subset for WMI-created processes. WMI command lines
 *  are limited (~32k chars), so the whole environment is never serialized;
 *  keep the denylist approach (fewer maintenance traps than a whitelist). */
function filterEnv(env) {
    const out = {};
    for (const [k, v] of Object.entries(env || {})) {
        if (v === undefined) continue;
        if (k === 'Path' || k === 'PATH' || k === 'SystemRoot' || k === 'TEMP' || k === 'TMP') continue;
        if (k.startsWith('=')) continue;
        out[k] = v;
    }
    return out;
}

/** WMI-created process: parented to WmiPrvSE.exe, outside any caller Job Object. */
function spawnDetached(exe, args, opts = {}) {
    const env = opts.env || process.env;
    const pid = execWmi(buildWmiCreateCommand(exe, args, filterEnv(env)));
    if (pid) return pid;
    // WMI unavailable (AV policy etc.) — fall back to plain spawn; callers warn.
    const { spawn } = require('child_process');
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true, env });
    child.unref();
    return child.pid;
}

/** Spawn the daemon supervisor detached, outside the caller's Job Object. */
function spawnSupervisor(nodeExe, argv, env, logFile) {
    try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); } catch (_) {}
    const pid = execWmi(buildWmiCreateCommand(nodeExe, argv, filterEnv(env)));
    if (!pid) {
        // Last resort: plain spawn (dies with caller's job — engine warns).
        const { spawn } = require('child_process');
        const out = fs.openSync(logFile, 'a');
        const child = spawn(nodeExe, argv, { detached: true, stdio: ['ignore', out, out], env, windowsHide: true });
        child.unref();
        fs.closeSync(out);
        return child.pid;
    }
    return pid;
}

/** taskkill /T against the owned tree (only after validated stop intent). */
function terminateTree(pid, opts = {}) {
    const log = opts.log || (() => {});
    if (!isProcessAlive(pid)) return true;
    try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 10_000, stdio: 'ignore', windowsHide: true });
    } catch (_) {
        log('taskkill failed for PID ' + pid);
        return false;
    }
    return !isProcessAlive(pid);
}

module.exports = { discoverChrome, isProcessAlive, processIdentity, spawnDetached, spawnSupervisor, terminateTree, winArgQuote, buildWmiCreateCommand };
