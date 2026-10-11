#!/usr/bin/env node
/**
 * scripts/lib/seat-lock.cjs — CLI for skills/lib/seatLock.js
 *
 * Usage:
 *   seat-lock acquire <port> --owner X [--task T] [--pid P|--no-pid] [--ttl-min N]
 *   seat-lock release <port> --owner X [--token T]
 *   seat-lock renew   <port> --owner X --token T [--ttl-min N]
 *   seat-lock status  <port> [--json]
 *
 * Exit: 0 ok · 2 busy · 64 usage
 *
 * Default acquire is TTL-only (no pid): shell callers exit immediately so a
 * recorded pid would go stale at once. computerUse / bot holders must pass
 * --pid and `renew` or `release` before TTL expiry (default 30 min).
 */
'use strict';

const path = require('path');
const { acquireSeatLock, releaseSeatLock, renewSeatLock, readSeatLock, defaultTtlMs } =
    require(path.join(__dirname, '..', '..', 'skills', 'lib', 'seatLock.js'));

function usage() {
    return [
        'Usage:',
        '  seat-lock acquire <port> --owner X [--task T] [--pid P|--no-pid] [--ttl-min N] [--json]',
        '  seat-lock release <port> --owner X [--token T] [--json]',
        '  seat-lock renew   <port> --owner X --token T [--ttl-min N] [--json]',
        '  seat-lock status  <port> [--json]',
        '',
        'Exit: 0 ok · 2 busy · 64 usage',
        '',
        'Default acquire is TTL-only (no pid) because shell callers exit immediately.',
        'computerUse/bot holders must pass --pid and renew or release before TTL expiry.',
        `Default TTL: ${Math.round(defaultTtlMs() / 60000)} min (AGENTCHAT_SEAT_LOCK_TTL_MS).`,
        'Lock path: ${AGENTCHAT_SEAT_LOCK_DIR || /tmp}/agentchat-seat-<port>.lock',
    ].join('\n');
}

function parseArgs(argv) {
    const out = {
        cmd: null,
        port: null,
        owner: null,
        task: null,
        pid: null,
        noPid: false,
        pidSet: false,
        token: null,
        ttlMin: null,
        json: false,
        help: false,
        unknown: null,
    };
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') out.help = true;
        else if (a === '--json') out.json = true;
        else if (a === '--no-pid') {
            out.noPid = true;
            out.pidSet = true;
            out.pid = null;
        } else if (a === '--owner') {
            out.owner = argv[++i];
        } else if (a.startsWith('--owner=')) {
            out.owner = a.slice('--owner='.length);
        } else if (a === '--task') {
            out.task = argv[++i];
        } else if (a.startsWith('--task=')) {
            out.task = a.slice('--task='.length);
        } else if (a === '--token') {
            out.token = argv[++i];
        } else if (a.startsWith('--token=')) {
            out.token = a.slice('--token='.length);
        } else if (a === '--pid') {
            const v = argv[++i];
            out.pid = parseInt(v, 10);
            out.pidSet = true;
        } else if (a.startsWith('--pid=')) {
            out.pid = parseInt(a.slice('--pid='.length), 10);
            out.pidSet = true;
        } else if (a === '--ttl-min') {
            out.ttlMin = parseInt(argv[++i], 10);
        } else if (a.startsWith('--ttl-min=')) {
            out.ttlMin = parseInt(a.slice('--ttl-min='.length), 10);
        } else if (a.startsWith('--')) {
            out.unknown = a;
        } else {
            rest.push(a);
        }
    }
    out.cmd = rest[0] || null;
    if (rest[1] != null) out.port = parseInt(rest[1], 10);
    return out;
}

function printJson(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
}

function run(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.help || !args.cmd) {
        console.log(usage());
        return args.help ? 0 : 64;
    }
    if (args.unknown) {
        console.error(usage());
        console.error(`Unknown arg: ${args.unknown}`);
        return 64;
    }
    const cmds = ['acquire', 'release', 'renew', 'status'];
    if (!cmds.includes(args.cmd)) {
        console.error(usage());
        console.error(`Unknown command: ${args.cmd}`);
        return 64;
    }
    if (!Number.isInteger(args.port) || args.port < 1) {
        console.error('port must be a positive integer');
        console.error(usage());
        return 64;
    }

    if (args.cmd === 'status') {
        const st = readSeatLock(args.port);
        if (args.json) {
            printJson({ port: args.port, ...st, token: undefined });
        } else {
            const bits = [
                `state=${st.state}`,
                `port=${args.port}`,
                st.owner ? `owner=${st.owner}` : null,
                st.pid != null ? `pid=${st.pid}` : null,
                st.task ? `task=${st.task}` : null,
                st.expires_at ? `expires_at=${st.expires_at}` : null,
            ].filter(Boolean);
            process.stdout.write(bits.join(' ') + '\n');
        }
        return 0;
    }

    if (!args.owner) {
        console.error('--owner is required');
        console.error(usage());
        return 64;
    }

    if (args.cmd === 'acquire') {
        const opts = { owner: args.owner, task: args.task || null };
        // CLI default: TTL-only (no pid). --pid P records a pid.
        if (args.pidSet && !args.noPid) {
            if (!Number.isInteger(args.pid) || args.pid <= 0) {
                console.error('--pid requires a positive integer');
                return 64;
            }
            opts.pid = args.pid;
        } else {
            opts.pid = null;
        }
        if (args.ttlMin != null) {
            if (!Number.isInteger(args.ttlMin) || args.ttlMin <= 0) {
                console.error('--ttl-min requires a positive integer');
                return 64;
            }
            opts.ttlMs = args.ttlMin * 60 * 1000;
        }
        const handle = acquireSeatLock(args.port, opts);
        if (!handle) {
            const st = readSeatLock(args.port);
            if (args.json) printJson({ ok: false, busy: true, port: args.port, state: st.state, owner: st.owner });
            else process.stderr.write(`busy port=${args.port} owner=${st.owner || '?'}\n`);
            return 2;
        }
        if (args.json) printJson({ ok: true, port: handle.port, token: handle.token, owner: handle.owner, expires_at: handle.expires_at });
        else process.stdout.write(`ok port=${handle.port} token=${handle.token} owner=${handle.owner} expires_at=${handle.expires_at}\n`);
        return 0;
    }

    if (args.cmd === 'release') {
        const handle = {
            port: args.port,
            path: require(path.join(__dirname, '..', '..', 'skills', 'lib', 'seatLock.js')).seatLockPath(args.port),
            owner: args.owner,
            token: args.token || undefined,
        };
        if (!args.token) {
            // Owner-only release: load token from the file if owner matches.
            const st = readSeatLock(args.port);
            if (st.state === 'free') {
                if (args.json) printJson({ ok: true, already_free: true, port: args.port });
                else process.stdout.write(`ok already-free port=${args.port}\n`);
                return 0;
            }
            if (st.owner !== args.owner) {
                console.error(`release refused: owner mismatch (have ${st.owner || '?'})`);
                return 2;
            }
            handle.token = st.token;
        }
        const ok = releaseSeatLock(handle);
        if (!ok) {
            console.error('release refused: token/owner does not own the lock');
            return 2;
        }
        if (args.json) printJson({ ok: true, port: args.port });
        else process.stdout.write(`ok released port=${args.port}\n`);
        return 0;
    }

    if (args.cmd === 'renew') {
        if (!args.token) {
            console.error('renew requires --token');
            console.error(usage());
            return 64;
        }
        const { seatLockPath } = require(path.join(__dirname, '..', '..', 'skills', 'lib', 'seatLock.js'));
        const handle = {
            port: args.port,
            path: seatLockPath(args.port),
            owner: args.owner,
            token: args.token,
        };
        const opts = {};
        if (args.ttlMin != null) {
            if (!Number.isInteger(args.ttlMin) || args.ttlMin <= 0) {
                console.error('--ttl-min requires a positive integer');
                return 64;
            }
            opts.ttlMs = args.ttlMin * 60 * 1000;
        }
        const next = renewSeatLock(handle, opts);
        if (!next) {
            console.error('renew refused: token/owner does not own the lock');
            return 2;
        }
        if (args.json) printJson({ ok: true, port: next.port, token: next.token, expires_at: next.expires_at });
        else process.stdout.write(`ok renewed port=${next.port} token=${next.token} expires_at=${next.expires_at}\n`);
        return 0;
    }

    return 64;
}

if (require.main === module) {
    process.exit(run());
}

module.exports = { run, parseArgs, usage };
