#!/usr/bin/env node
/**
 * scripts/lib/seat-census.cjs
 *
 * Live Box Chrome Seat Census & Fail-Closed Safety Checker for AgentChat.
 *
 * Operational Context & Invariant:
 * On multi-tenant / multi-fork test environments (e.g. cursor-box), multiple
 * agents/forks run separate Chrome instances on dedicated X displays:
 *   - DISPLAY :N → Fork-N → CDP port 9222+N
 *   - Fork-N profile: /home/box/chrome-profile/Fork-N
 *   - Port 9222 is reserved as AgentChat's default CDP endpoint.
 *
 * Ownership Collision & Fail-Closed Guard:
 * When AgentChat's local config (.env / ~/.agentchat/.env) specifies CDP_PORT=9227
 * or CHROME_PROFILE=/home/box/chrome-profile/Fork-5 while an external agent/fork
 * (Fork-5) actively occupies that seat, starting Chrome, modifying .env, killing
 * Chrome, starting demo server (:8737), or launching Coolify causes split-brain
 * state or destroys the other fork's active session.
 *
 * Actions are STRICTLY REFUSED unless Karl gives explicit go-ahead:
 *   - NO killing any Chrome processes.
 *   - NO modifying or rewriting .env files.
 *   - NO starting demo_server (:8737) or Coolify.
 *   - NO launching or restarting Chrome on contested seats (e.g. 9227).
 *
 * This module exports:
 *   - KNOWN_BOX_SEATS: the authoritative census table
 *   - probeCdpPort(port, host, timeoutMs): HTTP probe to check CDP responsiveness
 *   - inspectSeatConfig(env): inspects configured CDP vs known seats and detects collision
 *   - guardUnsafeAction(actionName, options): throws on prohibited actions
 *   - runCli(argv, env): CLI entry point
 */

'use strict';

const http = require('http');
const path = require('path');

const AGENTCHAT_DEFAULT_CDP_PORT = 9222;
const BOX_PROFILE_ROOT = '/home/box/chrome-profile';
const UNSAFE_ACTIONS = Object.freeze([
    'kill-chrome',
    'rewrite-env',
    'start-8737',
    'start-coolify',
    'claim-seat-9227',
    'launch-contested-chrome',
]);

function forkSeat(number, overrides = {}) {
    if (!Number.isInteger(number) || number < 1) {
        throw new TypeError(`Fork seat number must be a positive integer; got ${number}`);
    }
    return {
        seat: `Fork-${number}`,
        display: `:${number}`,
        port: AGENTCHAT_DEFAULT_CDP_PORT + number,
        profile: `${BOX_PROFILE_ROOT}/Fork-${number}`,
        assignedOwner: `Fork-${number}`,
        status: 'occupied',
        notes: `Occupied by Fork-${number}.`,
        ...overrides,
    };
}

// Authoritative live box seat census table as coordinated
const KNOWN_BOX_SEATS = [
    forkSeat(5, { notes: 'Contested seat. Fail-closed against killing or hijacking.' }),
    forkSeat(4),
    forkSeat(10),
    {
        seat: 'AgentChat',
        display: null,
        port: AGENTCHAT_DEFAULT_CDP_PORT,
        profile: null,
        assignedOwner: 'AgentChat',
        status: 'reserved',
        notes: 'Reserved as the AgentChat default CDP endpoint; it does not claim a Fork-N display or profile.',
    },
];

/**
 * Probe a CDP port via HTTP /json/version
 * Returns Promise<{ up: boolean, data?: object, error?: string }>
 */
function probeCdpPort(port, host = '127.0.0.1', timeoutMs = 1500) {
    return new Promise((resolve) => {
        const req = http.get({
            host,
            port: Number(port),
            path: '/json/version',
            timeout: timeoutMs,
        }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const parsed = JSON.parse(body);
                        resolve({ up: true, data: parsed });
                    } catch (_) {
                        resolve({ up: true, raw: body });
                    }
                } else {
                    resolve({ up: false, error: `HTTP status ${res.statusCode}` });
                }
            });
        });
        req.on('error', (err) => resolve({ up: false, error: err.code || err.message }));
        req.on('timeout', () => { req.destroy(); resolve({ up: false, error: 'TIMEOUT' }); });
    });
}

/**
 * Probe all known box seats asynchronously.
 */
async function probeAllSeats(host = '127.0.0.1', timeoutMs = 1500) {
    const results = [];
    for (const seat of KNOWN_BOX_SEATS) {
        const res = await probeCdpPort(seat.port, host, timeoutMs);
        results.push({
            ...seat,
            livePortUp: res.up,
            probeDetail: res.data || res.error,
        });
    }
    return results;
}

/**
 * Inspect active AgentChat configuration against the census table.
 */
function inspectSeatConfig(env = process.env) {
    const cdpPort = parseInt(env.CDP_PORT || String(AGENTCHAT_DEFAULT_CDP_PORT), 10);
    const profile = env.CHROME_PROFILE || env.CHROME_DEBUG_PROFILE || null;
    const cdpHost = env.CDP_HOST || '127.0.0.1';

    // Find if configured port matches any known box seat
    const matchedSeat = KNOWN_BOX_SEATS.find(s => s.port === cdpPort) || null;
    const isContested = matchedSeat && matchedSeat.assignedOwner && matchedSeat.assignedOwner !== 'AgentChat';
    const normalizedProfile = profile ? path.normalize(profile) : null;
    const matchedProfileSeat = normalizedProfile
        ? KNOWN_BOX_SEATS.find(s => s.profile && path.normalize(s.profile) === normalizedProfile) || null
        : null;
    const fork5Profiles = [
        path.normalize('/home/box/chrome-profile/Fork-5'),
        path.normalize('/home/box/chrome-profile-5'),
    ];
    const isFork5Collision = (cdpPort === 9227) || !!(normalizedProfile && fork5Profiles.includes(normalizedProfile));
    const collisionSeat = (matchedSeat && matchedSeat.assignedOwner !== 'AgentChat' ? matchedSeat : null)
        || matchedProfileSeat;
    const isSeatCollision = !!collisionSeat || isFork5Collision;

    return {
        configuredPort: cdpPort,
        configuredProfile: profile,
        configuredHost: cdpHost,
        matchedSeat,
        matchedProfileSeat,
        isContested: !!isContested,
        isSeatCollision,
        isFork5Collision: !!isFork5Collision,
        failClosedReason: isSeatCollision
            ? `Seat collision: ${collisionSeat ? collisionSeat.seat : 'Fork-5'} owns its DISPLAY, profile, and CDP endpoint. AgentChat defaults to its reserved CDP port ${AGENTCHAT_DEFAULT_CDP_PORT} and must not borrow a Fork-N seat.`
            : null,
    };
}

/**
 * Guard against unsafe operations.
 * Throws an Error with code ERR_SEAT_FAIL_CLOSED if the action is prohibited.
 */
function guardUnsafeAction(actionName, options = {}) {
    const env = options.env || process.env;
    const cfg = inspectSeatConfig(env);
    const karlAuthorized = !!(options.karlAuthorized || env.AGENTCHAT_KARL_AUTHORIZED === '1');

    if (UNSAFE_ACTIONS.includes(actionName)) {
        if (!karlAuthorized) {
            const err = new Error(
                `[FAIL-CLOSED BLOCKED] Action "${actionName}" is strictly REFUSED.\n` +
                `Reason: Multi-agent seat guard on the live box (DISPLAY :N uses /home/box/chrome-profile/Fork-N and CDP 9222+N; AgentChat reserves CDP 9222).\n` +
                `Invariant: Do NOT kill Chrome, rewrite live .env, start :8737, or start Coolify without explicit Karl go-ahead.\n` +
                (cfg.failClosedReason ? `Config notice: ${cfg.failClosedReason}\n` : '') +
                `To proceed only when Karl explicitly authorized this action, set AGENTCHAT_KARL_AUTHORIZED=1.`
            );
            err.code = 'ERR_SEAT_FAIL_CLOSED';
            err.action = actionName;
            throw err;
        }
    }

    return { allowed: true, action: actionName, karlAuthorized: true };
}

/**
 * Format census and diagnostic report as plain text or JSON.
 */
function formatReport(configReport, seatProbes, options = {}) {
    if (options.json) {
        return JSON.stringify({
            timestamp: new Date().toISOString(),
            config: configReport,
            census: seatProbes,
            rules: {
                failClosedDefault: true,
                prohibitedActions: UNSAFE_ACTIONS,
            },
        }, null, 2);
    }

    const lines = [];
    lines.push('======================================================================');
    lines.push('        AgentChat Live Box Chrome Seat Census & Fail-Closed Guard      ');
    lines.push('======================================================================');
    lines.push('');
    lines.push('Current AgentChat Configuration:');
    lines.push(`  CDP Host:    ${configReport.configuredHost}`);
    lines.push(`  CDP Port:    ${configReport.configuredPort}`);
    lines.push(`  Profile:     ${configReport.configuredProfile || '(default / unset)'}`);
    if (configReport.isSeatCollision) {
        const owner = (configReport.matchedProfileSeat || configReport.matchedSeat || {}).assignedOwner || 'a Fork-N owner';
        lines.push(`  [!] WARNING: Configuration targets ${owner}'s DISPLAY/profile/CDP seat!`);
        lines.push('  [!] STATUS:  FAIL-CLOSED. Operating on this seat without Karl assignment');
        lines.push(`               causes split-brain vs live ${owner}.`);
    } else {
        lines.push('  Status:      Safe / Not directly conflicting with a known Fork-N seat.');
    }
    lines.push('');
    lines.push('Live Box Seat Census (from coordinator):');
    lines.push('----------------------------------------------------------------------');
    lines.push('DISPLAY  SEAT        CDP PORT  ASSIGNED OWNER  LIVE STATUS  NOTES');
    lines.push('----------------------------------------------------------------------');

    for (const s of seatProbes) {
        const d = (s.display || 'n/a').padEnd(8);
        const name = s.seat.padEnd(11);
        const port = String(s.port).padEnd(9);
        const owner = (s.assignedOwner || 'unassigned').padEnd(15);
        const live = (s.livePortUp ? 'UP (reachable)' : 'DOWN/CLOSED').padEnd(12);
        lines.push(`${d} ${name} ${port} ${owner} ${live} ${s.notes}`);
    }

    lines.push('----------------------------------------------------------------------');
    lines.push('');
    lines.push('Fail-Closed Safety Directives:');
    lines.push('  [x] REFUSE killing Chrome processes');
    lines.push('  [x] REFUSE rewriting or overwriting live .env');
    lines.push('  [x] REFUSE binding :8737 or starting Coolify');
    lines.push('  [x] REFUSE self-claiming :5 / CDP 9227 without Karl go-ahead');
    lines.push('');
    lines.push('Safe Next Action:');
    if (configReport.isSeatCollision) {
        lines.push(`  Use AgentChat's reserved default CDP port ${AGENTCHAT_DEFAULT_CDP_PORT}, or wait for Karl to assign an isolated seat.`);
        lines.push('  Do not modify .env or kill any running Chrome instance.');
    } else {
        lines.push('  Normal safe operation. Continue with assigned non-conflicting port.');
    }
    lines.push('======================================================================');

    return lines.join('\n');
}

/**
 * CLI Runner
 */
async function runCli(argv = process.argv.slice(2), env = process.env) {
    let json = false;
    let checkAction = null;
    let probeLive = true;

    for (const arg of argv) {
        if (arg === '--json') json = true;
        else if (arg === '--no-probe') probeLive = false;
        else if (arg.startsWith('--check-action=')) {
            checkAction = arg.slice('--check-action='.length);
        } else if (arg === '--help' || arg === '-h') {
            console.log([
                'Usage: node scripts/lib/seat-census.cjs [options]',
                '',
                'Options:',
                '  --json                 Output report in structured JSON format',
                '  --no-probe             Skip live TCP/HTTP port probing (census-only)',
                '  --check-action=ACTION  Verify if an action is allowed under fail-closed policy',
                '                         (e.g. kill-chrome, rewrite-env, start-8737, start-coolify)',
                '  -h, --help             Show this help message',
            ].join('\n'));
            return 0;
        }
    }

    if (checkAction) {
        try {
            guardUnsafeAction(checkAction, { env });
            console.log(`[ALLOWED] Action "${checkAction}" permitted.`);
            return 0;
        } catch (err) {
            console.error(err.message);
            return 1;
        }
    }

    const configReport = inspectSeatConfig(env);
    let seatProbes;
    if (probeLive) {
        seatProbes = await probeAllSeats(configReport.configuredHost, 1000);
    } else {
        seatProbes = KNOWN_BOX_SEATS.map(s => ({ ...s, livePortUp: false, probeDetail: 'skipped' }));
    }

    const output = formatReport(configReport, seatProbes, { json });
    console.log(output);

    // If configuration has a conflict and we are running in fail-closed check mode,
    // we return exit code 0 for informational report, but indicate collision in stderr.
    if (configReport.isSeatCollision) {
        process.stderr.write('[FAIL-CLOSED NOTICE] Configuration targets a known Fork-N seat. Unsafe actions blocked.\n');
    }

    return 0;
}

if (require.main === module) {
    runCli().then(code => process.exit(code));
}

module.exports = {
    AGENTCHAT_DEFAULT_CDP_PORT,
    BOX_PROFILE_ROOT,
    UNSAFE_ACTIONS,
    forkSeat,
    KNOWN_BOX_SEATS,
    probeCdpPort,
    probeAllSeats,
    inspectSeatConfig,
    guardUnsafeAction,
    formatReport,
    runCli,
};
