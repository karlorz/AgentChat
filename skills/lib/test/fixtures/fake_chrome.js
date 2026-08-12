#!/usr/bin/env node
/**
 * Fake Chrome fixture for lifecycle tests (zero dependencies).
 *
 * Behaves like a CDP-enabled Chrome well enough for the engine's contract:
 *  - parses --remote-debugging-port=N from argv and serves a minimal
 *    /json/version endpoint on 127.0.0.1:N (the engine's readiness probe);
 *  - appends its full argv to the launch log (one line per invocation);
 *  - reads a JSON control file for behavior: { stayMs, exitCode }.
 *
 * The control file is re-read just before the exit timer fires, so tests can
 * switch behavior between launches (crash first, then clean) after observing
 * a new launch in the log.
 *
 * Default control: { stayMs: 1000, exitCode: 0 }.
 */
'use strict';

const fs = require('fs');
const http = require('http');

const LOG = process.env.FAKE_CHROME_LOG;
const CONTROL = process.env.FAKE_CHROME_CONTROL;

function readControl() {
    try {
        return JSON.parse(fs.readFileSync(CONTROL, 'utf8'));
    } catch (_) {
        return { stayMs: 1000, exitCode: 0 };
    }
}

function main() {
    const argv = process.argv.slice(2);
    if (LOG) {
        fs.appendFileSync(LOG, JSON.stringify(argv) + '\n');
    }
    const portArg = argv.find((a) => a.startsWith('--remote-debugging-port='));
    const port = portArg ? Number(portArg.split('=')[1]) : 0;

    let server = null;
    if (port) {
        server = http.createServer((req, res) => {
            if (req.url === '/json/version') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ Browser: 'FakeChrome/0.0', 'Protocol-Version': '1.3' }));
            } else {
                res.writeHead(404);
                res.end();
            }
        });
        server.listen(port, '127.0.0.1');
    }

    const initial = readControl();
    const stayMs = Number(initial.stayMs) || 1000;
    setTimeout(() => {
        // Re-read: the test may have switched this launch to a clean exit.
        const ctl = readControl();
        const exitCode = Number(ctl.exitCode) || 0;
        if (server) server.close();
        process.exit(exitCode);
    }, stayMs);
}

main();
