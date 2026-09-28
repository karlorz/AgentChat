#!/usr/bin/env node
/**
 * AgentChat-Muse — draft-only Muse.ai secondary social ops checklist.
 *
 * v1 does NOT drive Muse CDP / burn OTP / create accounts. It prints the
 * hard-won ops rules + a handoff template and emits a receipt so invoke =
 * execute stays enforceable.
 *
 * Usage:
 *   node skills/AgentChat-Muse/index.js
 *   node skills/AgentChat-Muse/index.js --ops-checklist
 *   node skills/AgentChat-Muse/index.js --smoke
 *   node skills/AgentChat-Muse/index.js --doctor
 *   node skills/AgentChat-Muse/index.js --json
 *
 * Exit: 0 ok · 64 usage · 4 internal
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { makeRunId, emitReceipt } = require('../lib/receipt');
const { log: _log } = require('../lib/terminal');

const SKILL_DIR = __dirname;
const SKILL = 'AgentChat-Muse';
const PREFIX = 'muse';
const log = (msg) => _log(PREFIX, msg);

const EXAMPLE_THREADS = Object.freeze({
    x: 'https://muse.ai/thread/9c35d3a6-81fc-44ca-a199-046789429bdb',
    tiktok: 'https://muse.ai/thread/5d1e050f-b198-4143-8e77-d881cfe69403',
    linkedin: 'parked',
});

const PACK_HINT =
    '/workspace/archive/2026-09/social-secondary-2026-09-27/ (mode-600 packs — never commit; never paste secrets)';

function usage() {
    return [
        'Usage: node index.js [--ops-checklist] [--smoke] [--doctor] [--json]',
        '  (default) --ops-checklist   print draft-only Muse ops rules + handoff template',
        '  --smoke                     verify skill files + productMap registration',
        '  --doctor                    smoke + warn on world-readable pack paths if present',
        '  --json                      also print a machine JSON summary on stdout',
        '',
        'Never opens Muse, never triggers SMS, never posts. Draft / operator handoff only.',
    ].join('\n');
}

function parseArgs(argv) {
    const out = {
        opsChecklist: false,
        smoke: false,
        doctor: false,
        json: false,
        help: false,
        unknown: null,
    };
    let sawMode = false;
    for (const a of argv) {
        if (a === '--help' || a === '-h') out.help = true;
        else if (a === '--ops-checklist' || a === '--checklist') {
            out.opsChecklist = true;
            sawMode = true;
        } else if (a === '--smoke') {
            out.smoke = true;
            sawMode = true;
        } else if (a === '--doctor') {
            out.doctor = true;
            sawMode = true;
        } else if (a === '--json') out.json = true;
        else out.unknown = a;
    }
    if (!sawMode && !out.help) out.opsChecklist = true;
    return out;
}

function printOpsChecklist() {
    const lines = [
        'AgentChat-Muse ops checklist (DRAFT-ONLY)',
        '========================================',
        '1. Ask Karl BEFORE triggering SMS — OTP expires in minutes; never burn while stuck.',
        '2. Muse Continue often anti-bot — hand off to operator / desktop Chrome; no blind loops.',
        '3. TikTok web often app-only / rate-limited — after Muse create, finish in App; keep Muse thread URL.',
        '4. LinkedIn PARKED unless Karl reopens.',
        '5. Muse chat: short + clear; one step per message; repeat if Muse misses.',
        '6. Stop on Karl STOP — no thrash. Leave thread URL + last state.',
        '',
        'Hard posture:',
        '- Draft-only: never auto-post / schedule / campaign',
        '- Never touch primary @karldigi X (secondary only)',
        '- :8737 stays OFF until Karl says start',
        '- No invented first GitHub release for this fork',
        `- Secrets: reference pack paths only → ${PACK_HINT}`,
        '',
        'Example Muse threads (pointers; may be stale):',
        `- X: ${EXAMPLE_THREADS.x}`,
        `- TikTok: ${EXAMPLE_THREADS.tiktok}`,
        `- LinkedIn: ${EXAMPLE_THREADS.linkedin}`,
        '',
        'Handoff template (fill, do not invent secrets):',
        '- Platform: X | TikTok | (LinkedIn only if reopened)',
        '- Muse thread URL:',
        '- Last visible Muse step:',
        '- Blocker: anti-bot Continue | waiting SMS (Karl asked?) | app-only | other',
        '- Ask Karl: yes/no for SMS now',
        '- Next human action:',
    ];
    for (const line of lines) log(line);
    return { mode: 'ops-checklist', threads: EXAMPLE_THREADS, pack_hint: PACK_HINT };
}

function runSmoke() {
    const skillMd = path.join(SKILL_DIR, 'SKILL.md');
    const indexJs = path.join(SKILL_DIR, 'index.js');
    const mapPath = path.join(SKILL_DIR, '..', 'lib', 'providers', 'productMap.js');
    const missing = [];
    if (!fs.existsSync(skillMd)) missing.push('SKILL.md');
    if (!fs.existsSync(indexJs)) missing.push('index.js');
    if (!fs.existsSync(mapPath)) missing.push('productMap.js');
    let registered = false;
    if (fs.existsSync(mapPath)) {
        const src = fs.readFileSync(mapPath, 'utf8');
        registered = /key:\s*'muse'/.test(src) && /AgentChat-Muse/.test(src);
    }
    log(`smoke: SKILL.md=${fs.existsSync(skillMd) ? 'ok' : 'MISSING'}`);
    log(`smoke: index.js=${fs.existsSync(indexJs) ? 'ok' : 'MISSING'}`);
    log(`smoke: productMap muse entry=${registered ? 'ok' : 'MISSING'}`);
    if (missing.length || !registered) {
        return { mode: 'smoke', ok: false, missing, registered };
    }
    return { mode: 'smoke', ok: true, missing: [], registered: true };
}

function runDoctor() {
    const smoke = runSmoke();
    const packRoot = '/workspace/archive/2026-09/social-secondary-2026-09-27';
    const warnings = [];
    if (fs.existsSync(packRoot)) {
        try {
            const st = fs.statSync(packRoot);
            // world-readable bit
            if ((st.mode & 0o004) !== 0) {
                warnings.push(`pack root world-readable: ${packRoot}`);
            }
            for (const name of ['x.json', 'tiktok.json', 'linkedin.json']) {
                const p = path.join(packRoot, name);
                if (!fs.existsSync(p)) continue;
                const m = fs.statSync(p).mode & 0o777;
                if ((m & 0o077) !== 0) {
                    warnings.push(`${name} mode=${m.toString(8)} (prefer 600)`);
                }
            }
        } catch (e) {
            warnings.push(`pack stat failed: ${e.message}`);
        }
        log(`doctor: pack root present at ${packRoot}`);
    } else {
        log('doctor: pack root not on this host (ok)');
    }
    for (const w of warnings) log(`doctor WARN: ${w}`);
    if (!warnings.length) log('doctor: no pack-permission warnings');
    return { ...smoke, mode: 'doctor', warnings };
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(usage());
        process.exit(0);
    }
    if (args.unknown) {
        console.error(usage());
        console.error(`Unknown arg: ${args.unknown}`);
        process.exit(64);
    }

    const runId = makeRunId();
    const started = Date.now();
    let summary;
    let exit = 0;

    try {
        if (args.smoke) summary = runSmoke();
        else if (args.doctor) summary = runDoctor();
        else summary = printOpsChecklist();

        if (summary && summary.ok === false) exit = 4;
    } catch (e) {
        log(`FATAL: ${e && e.message ? e.message : e}`);
        summary = { mode: 'error', error: String(e && e.message ? e.message : e) };
        exit = 4;
    }

    const receipt = emitReceipt({
        skillDir: SKILL_DIR,
        skill: SKILL,
        runId,
        fields: {
            exit,
            mode: summary && summary.mode,
            total_ms: Date.now() - started,
            draft_only: true,
            live_muse: false,
        },
        stream: 'stderr',
    });

    if (args.json) {
        console.log(JSON.stringify({ summary, receipt }, null, 2));
    }

    process.exit(exit);
}

if (require.main === module) {
    main();
}

module.exports = { parseArgs, printOpsChecklist, EXAMPLE_THREADS };
