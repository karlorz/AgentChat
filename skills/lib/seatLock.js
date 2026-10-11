/**
 * CDP seat lock — one holder per Chrome debugging port.
 *
 * Modeled on orca-slot + skills/lib/locks.js tryReclaim:
 *   atomic create via temp-file + linkSync (EEXIST = busy)
 *   stale reclaim via rename to a unique name (never delete a lock that
 *   changed hands)
 *
 * JSON: {owner, pid, host, task, token, started_at, expires_at}
 *
 * Stale when:
 *   - pid is set and dead on the same host (process.kill(pid, 0) ESRCH), OR
 *   - now > expires_at
 *
 * Default TTL 30 min (AGENTCHAT_SEAT_LOCK_TTL_MS). Library callers should
 * pass pid (default: this process) and renew/release. CLI default is
 * TTL-only (no pid) because shell callers exit immediately.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_DIR = '/tmp';

function lockDir(env = process.env) {
    return env.AGENTCHAT_SEAT_LOCK_DIR || DEFAULT_DIR;
}

function seatLockPath(port, env = process.env) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1) {
        throw new TypeError(`seat lock port must be a positive integer; got ${port}`);
    }
    return path.join(lockDir(env), `agentchat-seat-${n}.lock`);
}

function defaultTtlMs(env = process.env) {
    const n = parseInt(env.AGENTCHAT_SEAT_LOCK_TTL_MS, 10);
    if (Number.isFinite(n) && n > 0) return n;
    return DEFAULT_TTL_MS;
}

function newToken() {
    return crypto.randomBytes(16).toString('hex');
}

function parseLockFile(raw) {
    try {
        const data = JSON.parse(String(raw));
        if (!data || typeof data !== 'object') return null;
        return data;
    } catch (_) {
        return null;
    }
}

function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        if (e && e.code === 'ESRCH') return false;
        return true; // EPERM etc. — process exists, just not ours
    }
}

function isStale(data, now, hostname) {
    if (!data) return true;
    if (data.expires_at) {
        const exp = Date.parse(data.expires_at);
        if (Number.isFinite(exp) && now > exp) return true;
    }
    const pid = parseInt(data.pid, 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    const lockHost = data.host == null || data.host === '' ? hostname : String(data.host);
    if (lockHost !== hostname) return false; // other host: TTL only
    return !pidAlive(pid);
}

function emptyStatus() {
    return {
        state: 'free',
        owner: null,
        pid: null,
        task: null,
        started_at: null,
        expires_at: null,
    };
}

function statusFromData(data, now, hostname) {
    if (!data) return emptyStatus();
    const stale = isStale(data, now, hostname);
    return {
        state: stale ? 'stale' : 'held',
        owner: data.owner || null,
        pid: data.pid == null ? null : data.pid,
        task: data.task || null,
        started_at: data.started_at || null,
        expires_at: data.expires_at || null,
        token: data.token || null,
        host: data.host || null,
    };
}

function readSeatLock(port, opts = {}) {
    const env = opts.env || process.env;
    const now = opts.now || Date.now();
    const hostname = opts.hostname || os.hostname();
    const lockPath = seatLockPath(port, env);
    let raw;
    try {
        raw = fs.readFileSync(lockPath, 'utf8');
    } catch (e) {
        if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return emptyStatus();
        return { ...emptyStatus(), state: 'stale' };
    }
    const data = parseLockFile(raw);
    if (!data) return { ...emptyStatus(), state: 'stale' };
    return statusFromData(data, now, hostname);
}

function writeTempJson(lockPath, payload) {
    const tmp = `${lockPath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload) + '\n', { encoding: 'utf8', mode: 0o600 });
    return tmp;
}

function atomicCreate(lockPath, payload) {
    const tmp = writeTempJson(lockPath, payload);
    try {
        fs.linkSync(tmp, lockPath);
        return true;
    } catch (e) {
        if (e && e.code === 'EEXIST') return false;
        try {
            const fd = fs.openSync(lockPath, 'wx', 0o600);
            try {
                fs.writeFileSync(fd, JSON.stringify(payload) + '\n');
            } finally {
                try { fs.closeSync(fd); } catch (_) {}
            }
            return true;
        } catch (e2) {
            if (e2 && e2.code === 'EEXIST') return false;
            throw e2;
        }
    } finally {
        try { fs.unlinkSync(tmp); } catch (_) {}
    }
}

/**
 * Reclaim a stale lock via atomic rename. Loser of the race must NOT delete.
 * Returns true if this process moved the file out of the way.
 */
function tryReclaim(lockPath, expectedRaw) {
    const dest = `${lockPath}.stale.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString('hex')}`;
    try {
        fs.renameSync(lockPath, dest);
        try { fs.unlinkSync(dest); } catch (_) {}
        return true;
    } catch (_) {
        try {
            const current = fs.readFileSync(lockPath, 'utf8');
            if (expectedRaw == null || current !== expectedRaw) return false;
            // Same stale bytes still there; rename failed for another reason.
            // Do not unlink in place — another holder may have arrived.
            return false;
        } catch (_) {
            return false;
        }
    }
}

function makeHandle(port, lockPath, payload) {
    return {
        port: Number(port),
        path: lockPath,
        token: payload.token,
        owner: payload.owner,
        pid: payload.pid == null ? null : payload.pid,
        task: payload.task || null,
        started_at: payload.started_at,
        expires_at: payload.expires_at,
        host: payload.host,
    };
}

function acquireSeatLock(port, opts = {}) {
    const env = opts.env || process.env;
    const now = opts.now || Date.now();
    const hostname = opts.hostname || os.hostname();
    const owner = opts.owner;
    if (!owner) throw new TypeError('acquireSeatLock requires opts.owner');
    const ttlMs = opts.ttlMs != null ? Number(opts.ttlMs) : defaultTtlMs(env);
    const pid = Object.prototype.hasOwnProperty.call(opts, 'pid')
        ? (opts.pid == null || opts.pid === false ? null : parseInt(opts.pid, 10))
        : process.pid;
    const lockPath = seatLockPath(port, env);
    try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch (_) {}

    const payload = {
        owner: String(owner),
        pid: Number.isInteger(pid) && pid > 0 ? pid : null,
        host: hostname,
        task: opts.task ? String(opts.task) : null,
        token: newToken(),
        started_at: new Date(now).toISOString(),
        expires_at: new Date(now + ttlMs).toISOString(),
    };

    for (let i = 0; i < 8; i++) {
        if (atomicCreate(lockPath, payload)) return makeHandle(port, lockPath, payload);

        let raw;
        try {
            raw = fs.readFileSync(lockPath, 'utf8');
        } catch (e) {
            if (e && e.code === 'ENOENT') continue; // raced with a releaser
            return null;
        }
        const data = parseLockFile(raw);
        if (data && data.token && data.owner === payload.owner
            && payload.pid && data.pid === payload.pid && !isStale(data, now, hostname)) {
            // Same process already holds it — return the existing handle.
            return makeHandle(port, lockPath, data);
        }
        if (isStale(data, now, hostname) || !data) {
            if (tryReclaim(lockPath, raw)) continue;
        }
        return null; // held by someone else
    }
    return null;
}

function readRaw(lockPath) {
    try {
        return fs.readFileSync(lockPath, 'utf8');
    } catch (_) {
        return null;
    }
}

function ownsToken(data, handle) {
    if (!data || !handle) return false;
    if (handle.token && data.token !== handle.token) return false;
    if (handle.owner && data.owner && data.owner !== handle.owner) return false;
    return !!data.token && (!handle.token || data.token === handle.token);
}

function renewSeatLock(handle, opts = {}) {
    if (!handle || !handle.path || !handle.token) return null;
    const env = opts.env || process.env;
    const now = opts.now || Date.now();
    const ttlMs = opts.ttlMs != null ? Number(opts.ttlMs) : defaultTtlMs(env);
    const raw = readRaw(handle.path);
    if (raw == null) return null;
    const data = parseLockFile(raw);
    if (!ownsToken(data, handle)) return null;
    const next = {
        ...data,
        expires_at: new Date(now + ttlMs).toISOString(),
    };
    const tmp = writeTempJson(handle.path, next);
    try {
        // Recheck ownership before replacing.
        const raw2 = readRaw(handle.path);
        if (raw2 == null) return null;
        const data2 = parseLockFile(raw2);
        if (!ownsToken(data2, handle)) return null;
        fs.renameSync(tmp, handle.path);
        return makeHandle(handle.port, handle.path, next);
    } catch (_) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        return null;
    }
}

function releaseSeatLock(handle) {
    if (!handle || !handle.path) return false;
    const raw = readRaw(handle.path);
    if (raw == null) return false;
    const data = parseLockFile(raw);
    if (!ownsToken(data, handle)) return false;
    const dest = `${handle.path}.release.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString('hex')}`;
    try {
        fs.renameSync(handle.path, dest);
        try { fs.unlinkSync(dest); } catch (_) {}
        return true;
    } catch (_) {
        return false;
    }
}

module.exports = {
    DEFAULT_TTL_MS,
    seatLockPath,
    readSeatLock,
    acquireSeatLock,
    renewSeatLock,
    releaseSeatLock,
    defaultTtlMs,
};
