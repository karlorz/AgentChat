/**
 * Muse live --doctor probe tests (zero-dep, mocked CDP/http).
 */
'use strict';

const { spawnSync } = require('child_process');
const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DOCTOR = path.join(ROOT, 'skills', 'AgentChat-Muse', 'doctor.js');
const INDEX = path.join(ROOT, 'skills', 'AgentChat-Muse', 'index.js');

const {
    probe,
    publicResult,
    exitCodeFor,
    PUBLIC_KEYS,
} = require(DOCTOR);

const ADAPTER = Object.freeze({
    key: 'muse',
    authDomains: ['muse.ai/login', 'accounts.muse.ai', 'muse.ai/signin'],
    signedOutSelectors: [
        'input[placeholder*="Mobile number" i]',
        'input[placeholder*="email" i][placeholder*="Mobile" i]',
        'text=/Log in or create an account/i',
    ],
});

let pass = 0, fail = 0;
const test = (name, fn) => {
    const run = async () => {
        try {
            await fn();
            pass++;
            console.log('  PASS', name);
        } catch (err) {
            fail++;
            console.log('  FAIL', name, err && err.stack ? err.stack : err.message);
        }
    };
    return run();
};

function keysOf(r) {
    return Object.keys(publicResult(r)).sort();
}

function mockWs(handlers) {
    handlers.calls = handlers.calls || [];
    handlers.closedTargets = handlers.closedTargets || [];
    handlers.urls = handlers.urls || [];
    return async (url) => {
        handlers.urls.push(url);
        return {
            send: async (method, params) => {
                handlers.calls.push({ method, params, url });
                if (method === 'Target.createTarget') {
                    handlers.created = params;
                    return { targetId: handlers.targetId || 'bg-1' };
                }
                if (method === 'Target.closeTarget') {
                    handlers.closedTargets.push(params);
                    return { success: true };
                }
                if (method === 'Runtime.evaluate') {
                    if (handlers.evaluateErr) throw handlers.evaluateErr;
                    const snap = typeof handlers.snapshot === 'function'
                        ? handlers.snapshot()
                        : handlers.snapshot;
                    return { result: { type: 'object', value: snap } };
                }
                throw new Error('unexpected method ' + method);
            },
            close() { handlers.closedWs = (handlers.closedWs || 0) + 1; },
        };
    };
}

function readyDeps(over = {}) {
    const ws = over.wsHandlers || {};
    ws.snapshot = ws.snapshot || {
        href: 'https://muse.ai/',
        inputVisible: true,
        signedOutText: false,
        signedOutCss: false,
    };
    const list = over.list || [{
        type: 'page',
        url: 'https://muse.ai/',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9227/devtools/page/1',
        id: 'p1',
    }];
    let listN = 0;
    return {
        adapter: ADAPTER,
        getJson: over.getJson || (async (url) => {
            if (String(url).endsWith('/json/version')) {
                if (over.versionErr) throw over.versionErr;
                return { webSocketDebuggerUrl: 'ws://127.0.0.1:9227/devtools/browser' };
            }
            if (String(url).endsWith('/json/list')) {
                listN++;
                if (typeof over.listFn === 'function') return over.listFn(listN);
                return list;
            }
            throw new Error('unexpected ' + url);
        }),
        wsConnect: over.wsConnect || mockWs(ws),
        readSeatLock: over.readSeatLock || (() => ({ state: 'free' })),
        readChromeDisplay: over.readChromeDisplay || (() => ({ error: 'not found' })),
        ws,
    };
}

const OPTS = {
    env: { CDP_HOST: '127.0.0.1', CDP_PORT: '9227' },
    pid: process.pid,
    pollMs: 0,
    pollTimeoutMs: 0,
    now: () => Date.parse('2026-10-11T06:00:00.000Z'),
    log: () => {},
};

async function main() {
    console.log('── Muse doctor probe ──');

    await test('seat down = blocked/seat', async () => {
        const deps = readyDeps({ versionErr: new Error('ECONNREFUSED') });
        const r = await probe(OPTS, deps);
        assert.strictEqual(r.state, 'blocked');
        assert.strictEqual(r.reason, 'seat');
        assert.strictEqual(r.seat, 'Fork-5');
        assert.strictEqual(r.port, 9227);
        assert.strictEqual(r.display, ':5');
        assert.strictEqual(exitCodeFor(r.state), 3);
        assert.deepStrictEqual(keysOf(r), [...PUBLIC_KEYS].sort());
    });

    await test('display mismatch = blocked/seat', async () => {
        const deps = readyDeps({
            readChromeDisplay: () => ({ pid: 9, display: ':10' }),
        });
        const r = await probe(OPTS, deps);
        assert.strictEqual(r.state, 'blocked');
        assert.strictEqual(r.reason, 'seat');
    });

    await test('lock held by another pid = blocked/busy', async () => {
        const deps = readyDeps({
            readSeatLock: () => ({ state: 'held', owner: 'other', pid: process.pid + 99 }),
        });
        const r = await probe(OPTS, deps);
        assert.strictEqual(r.state, 'blocked');
        assert.strictEqual(r.reason, 'busy');
        assert.strictEqual(exitCodeFor(r.state), 3);
    });

    await test('stale lock is ignored and probe continues', async () => {
        const deps = readyDeps({
            readSeatLock: () => ({ state: 'stale', owner: 'dead', pid: 1 }),
        });
        const r = await probe(OPTS, deps);
        assert.strictEqual(r.state, 'ready');
        assert.strictEqual(r.reason, null);
    });

    await test('lock held by this pid is not busy', async () => {
        const deps = readyDeps({
            readSeatLock: () => ({ state: 'held', owner: 'self', pid: process.pid }),
        });
        const r = await probe({ ...OPTS, pid: process.pid }, deps);
        assert.strictEqual(r.state, 'ready');
    });

    await test('auth URL = needs_human/muse_login', async () => {
        const ws = {
            snapshot: {
                href: 'https://muse.ai/login?next=/',
                inputVisible: false,
                signedOutText: false,
                signedOutCss: false,
            },
        };
        const r = await probe(OPTS, readyDeps({ wsHandlers: ws }));
        assert.strictEqual(r.state, 'needs_human');
        assert.strictEqual(r.reason, 'muse_login');
        assert.strictEqual(exitCodeFor(r.state), 2);
    });

    await test('signed-out text = needs_human/muse_login', async () => {
        const ws = {
            snapshot: {
                href: 'https://muse.ai/',
                inputVisible: false,
                signedOutText: true,
                signedOutCss: false,
            },
        };
        const r = await probe(OPTS, readyDeps({ wsHandlers: ws }));
        assert.strictEqual(r.state, 'needs_human');
        assert.strictEqual(r.reason, 'muse_login');
    });

    await test('signed-out CSS marker = needs_human/muse_login', async () => {
        const ws = {
            snapshot: {
                href: 'https://muse.ai/',
                inputVisible: false,
                signedOutText: false,
                signedOutCss: true,
            },
        };
        const r = await probe(OPTS, readyDeps({ wsHandlers: ws }));
        assert.strictEqual(r.state, 'needs_human');
        assert.strictEqual(r.reason, 'muse_login');
    });

    await test('textarea visible = ready', async () => {
        const r = await probe(OPTS, readyDeps());
        assert.strictEqual(r.state, 'ready');
        assert.strictEqual(r.reason, null);
        assert.strictEqual(exitCodeFor(r.state), 0);
        const pub = publicResult(r);
        assert.deepStrictEqual(Object.keys(pub).sort(), [...PUBLIC_KEYS].sort());
        assert.strictEqual(Object.keys(pub).length, 6);
        assert(!Object.values(pub).includes('target_platform'));
    });

    await test('no textarea = blocked/no_input', async () => {
        const ws = {
            snapshot: {
                href: 'https://muse.ai/thread/abc',
                inputVisible: false,
                signedOutText: false,
                signedOutCss: false,
            },
        };
        const r = await probe(OPTS, readyDeps({ wsHandlers: ws }));
        assert.strictEqual(r.state, 'blocked');
        assert.strictEqual(r.reason, 'no_input');
    });

    await test('ws throw = blocked/cdp_error', async () => {
        const deps = readyDeps({
            wsConnect: async () => { throw new Error('ws boom'); },
        });
        const r = await probe(OPTS, deps);
        assert.strictEqual(r.state, 'blocked');
        assert.strictEqual(r.reason, 'cdp_error');
        assert.strictEqual(exitCodeFor(r.state), 3);
    });

    await test('created background tab is always closed', async () => {
        const ws = {
            snapshot: () => { throw new Error('evaluate failed'); },
            targetId: 'bg-9',
        };
        const deps = readyDeps({
            wsHandlers: ws,
            listFn: (n) => {
                if (n === 1) return [];
                return [{
                    type: 'page',
                    id: 'bg-9',
                    url: 'https://muse.ai/',
                    webSocketDebuggerUrl: 'ws://127.0.0.1:9227/devtools/page/bg-9',
                }];
            },
        });
        const r = await probe(OPTS, deps);
        assert.strictEqual(r.state, 'blocked');
        assert.strictEqual(r.reason, 'cdp_error');
        assert(ws.created, 'createTarget called');
        assert.strictEqual(ws.created.background, true);
        assert.strictEqual(ws.created.url, 'https://muse.ai/');
        assert.deepStrictEqual(ws.closedTargets, [{ targetId: 'bg-9' }]);
        assert(!ws.calls.some(c => c.method === 'Page.bringToFront' || c.method === 'Target.activateTarget'));
    });

    await test('never emits target_platform', async () => {
        const cases = [];
        cases.push(await probe(OPTS, readyDeps({ versionErr: new Error('down') })));
        cases.push(await probe(OPTS, readyDeps({
            readSeatLock: () => ({ state: 'held', pid: 1, owner: 'x' }),
        })));
        cases.push(await probe(OPTS, readyDeps()));
        for (const r of cases) {
            assert.notStrictEqual(r.reason, 'target_platform');
            assert.notStrictEqual(r.state, 'needs_human:target_platform');
            const pub = publicResult(r);
            assert.strictEqual(Object.keys(pub).length, 6);
        }
    });

    await test('exit-code mapping 0/2/3', async () => {
        assert.strictEqual(exitCodeFor('ready'), 0);
        assert.strictEqual(exitCodeFor('needs_human'), 2);
        assert.strictEqual(exitCodeFor('blocked'), 3);
    });

    await test('output has exactly the 6 keys', async () => {
        const r = await probe(OPTS, readyDeps());
        const pub = publicResult(r);
        assert.deepStrictEqual(Object.keys(pub).sort(), ['checked_at', 'display', 'port', 'reason', 'seat', 'state']);
        assert.strictEqual(pub.checked_at, '2026-10-11T06:00:00.000Z');
    });

    await test('CLI --doctor on a closed port exits 3 with blocked/seat JSON only on stdout', async () => {
        const run = spawnSync(process.execPath, [INDEX, '--doctor', '--json'], {
            encoding: 'utf8',
            env: {
                ...process.env,
                CDP_HOST: '127.0.0.1',
                CDP_PORT: '1',
                AGENTCHAT_NO_AUTOSTART: '1',
            },
        });
        assert.strictEqual(run.status, 3, run.stderr);
        const lines = run.stdout.trim().split('\n').filter(Boolean);
        assert.strictEqual(lines.length, 1, 'exactly one stdout JSON line, even with --json');
        const body = JSON.parse(lines[0]);
        assert.deepStrictEqual(Object.keys(body).sort(), [...PUBLIC_KEYS].sort());
        assert.strictEqual(body.state, 'blocked');
        assert.strictEqual(body.reason, 'seat');
        assert.strictEqual(body.port, 1);
        assert(run.stderr.includes('[receipt] AGENTCHAT_RUN'));
        assert(/"live_muse":true/.test(run.stderr));
        assert(/"draft_only":true/.test(run.stderr));
    });

    await test('CLI --doctor-static keeps old smoke+pack behavior (exit 0/4)', async () => {
        const run = spawnSync(process.execPath, [INDEX, '--doctor-static'], {
            encoding: 'utf8',
            env: { ...process.env, AGENTCHAT_NO_AUTOSTART: '1' },
        });
        assert.ok(run.status === 0 || run.status === 4, 'exit 0 or 4, got ' + run.status);
        assert.strictEqual(run.stdout.trim(), '');
        assert(run.stderr.includes('[receipt] AGENTCHAT_RUN'));
        assert(/"live_muse":false/.test(run.stderr));
    });

    await test('9222 maps to AgentChat seat with null display', async () => {
        const r = await probe({
            ...OPTS,
            env: { CDP_HOST: '127.0.0.1', CDP_PORT: '9222' },
        }, readyDeps({ versionErr: new Error('down') }));
        assert.strictEqual(r.seat, 'AgentChat');
        assert.strictEqual(r.display, null);
        assert.strictEqual(r.port, 9222);
    });

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
