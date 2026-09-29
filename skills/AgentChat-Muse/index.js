#!/usr/bin/env node
/**
 * AgentChat-Muse — Muse.ai LLM / agent-worker subagent + ops checklist.
 *
 * Muse IS on PROVIDER_CHAIN (adapters/muse.js). This skill is the operator /
 * subagent layer: checklist, worker plan, prompt templates, handoff text.
 * It does NOT drive Muse CDP / burn OTP / create accounts tonight.
 *
 * Usage:
 *   node skills/AgentChat-Muse/index.js
 *   node skills/AgentChat-Muse/index.js --ops-checklist
 *   node skills/AgentChat-Muse/index.js --worker-plan
 *   node skills/AgentChat-Muse/index.js --prompt-template
 *   node skills/AgentChat-Muse/index.js --handoff
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

const PROVIDER_NOTE =
    'Muse IS on PROVIDER_CHAIN (key muse → adapters/muse.js, near end). Skill = operator/subagent layer on top.';

function usage() {
    return [
        'Usage: node index.js [--ops-checklist] [--worker-plan] [--prompt-template] [--handoff] [--smoke] [--doctor] [--json]',
        '  (default) --ops-checklist   print draft-only Muse ops rules + handoff template',
        '  --worker-plan               print how to drive Muse as chat/research/social worker',
        '  --prompt-template           print short Muse prompt templates (general agent)',
        '  --handoff                   print operator desktop-Chrome handoff block',
        '  --smoke                     verify skill files + productMap + chain/adapter',
        '  --doctor                    smoke + warn on world-readable pack paths if present',
        '  --json                      also print a machine JSON summary on stdout',
        '',
        'Never opens Muse CDP, never triggers SMS, never posts. Draft / operator handoff only.',
        PROVIDER_NOTE,
    ].join('\n');
}

function parseArgs(argv) {
    const out = {
        opsChecklist: false,
        workerPlan: false,
        promptTemplate: false,
        handoff: false,
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
        } else if (a === '--worker-plan') {
            out.workerPlan = true;
            sawMode = true;
        } else if (a === '--prompt-template' || a === '--prompts') {
            out.promptTemplate = true;
            sawMode = true;
        } else if (a === '--handoff') {
            out.handoff = true;
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
        PROVIDER_NOTE,
        '',
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
    return { mode: 'ops-checklist', threads: EXAMPLE_THREADS, pack_hint: PACK_HINT, on_provider_chain: true };
}

function printWorkerPlan() {
    const lines = [
        'AgentChat-Muse worker plan (DRAFT-ONLY — no live CDP)',
        '====================================================',
        PROVIDER_NOTE,
        '',
        'Modes of work (pick one; stay draft-only tonight):',
        '1. Chat / Q&A worker',
        '   - Open muse.ai in desktop Chrome (or OneWeb classify/open key=muse).',
        '   - One short ask per turn; wait for completion; no novel-length prompts.',
        '   - Prefer OneWeb stronger providers for production until Muse live prove.',
        '2. Research worker',
        '   - Ask Muse to browse/summarize; quote Muse-returned sources only.',
        '   - Do not invent citations; stop on Karl STOP.',
        '3. Secondary social ops worker',
        '   - Only if Karl reopened social. Run --ops-checklist / --handoff first.',
        '   - Ask Karl BEFORE SMS. TikTok → App path after Muse create. LinkedIn parked.',
        '   - Never auto-post; never touch primary @karldigi X.',
        '',
        'Safe tonight without browser:',
        '  node skills/AgentChat-Muse/index.js --prompt-template',
        '  node skills/AgentChat-Muse/index.js --handoff',
        '  node skills/AgentChat-Muse/index.js --ops-checklist',
        '',
        'Out of scope tonight: live Muse CDP signup, SMS burn, Coolify, :8737, first release.',
    ];
    for (const line of lines) log(line);
    return {
        mode: 'worker-plan',
        on_provider_chain: true,
        tracks: ['chat', 'research', 'secondary-social'],
        live_cdp: false,
    };
}

function printPromptTemplate() {
    const lines = [
        'AgentChat-Muse prompt templates (short + clear)',
        '==============================================',
        'Rule: one instruction per message. Stop on Karl STOP.',
        '',
        '[Chat]',
        '  Reply in ≤8 bullets. Task: <one concrete ask>. Do not browse unless I say so.',
        '',
        '[Research]',
        '  Browse for <topic>. Return: 5 facts + source URLs Muse actually opened. No invented links.',
        '',
        '[Secondary social — only if Karl reopened]',
        '  Continue the existing Muse thread for <platform>. Do ONE visible UI step.',
        '  If Continue/CAPTCHA/anti-bot appears: STOP and report blocker. Do not trigger SMS.',
        '',
        '[Handoff to human]',
        '  Pause. Summarize last step + blocker in 3 lines. Wait for operator.',
        '',
        PROVIDER_NOTE,
    ];
    for (const line of lines) log(line);
    return { mode: 'prompt-template', on_provider_chain: true };
}

function printHandoff() {
    const lines = [
        'AgentChat-Muse operator handoff (desktop Chrome)',
        '===============================================',
        PROVIDER_NOTE,
        '',
        'Fill before handing to human (no secrets in chat):',
        `- Muse URL: https://muse.ai/  (or thread: ${EXAMPLE_THREADS.x} / ${EXAMPLE_THREADS.tiktok})`,
        '- Goal: chat | research | secondary-social (X|TikTok; LinkedIn parked)',
        '- Last Muse step visible:',
        '- Blocker: none | anti-bot Continue | CAPTCHA | waiting SMS | app-only | other',
        '- SMS: NOT requested (ask Karl first if needed)',
        '- Preferred path: desktop Chrome / operator — do not blind-loop Continue',
        '- TikTok: after Muse create → finish in App; keep thread URL',
        '- Stop condition: Karl STOP or blocker above',
        `- Pack path (local only): ${PACK_HINT}`,
        '',
        'Agent next action: wait for Karl / operator; do not launch CDP signup.',
    ];
    for (const line of lines) log(line);
    return { mode: 'handoff', threads: EXAMPLE_THREADS, on_provider_chain: true, live_muse: false };
}

function runSmoke() {
    const skillMd = path.join(SKILL_DIR, 'SKILL.md');
    const indexJs = path.join(SKILL_DIR, 'index.js');
    const mapPath = path.join(SKILL_DIR, '..', 'lib', 'providers', 'productMap.js');
    const chainPath = path.join(SKILL_DIR, '..', 'lib', 'providers', 'chain.js');
    const adapterPath = path.join(SKILL_DIR, '..', 'lib', 'providers', 'adapters', 'muse.js');
    const missing = [];
    if (!fs.existsSync(skillMd)) missing.push('SKILL.md');
    if (!fs.existsSync(indexJs)) missing.push('index.js');
    if (!fs.existsSync(mapPath)) missing.push('productMap.js');
    if (!fs.existsSync(chainPath)) missing.push('chain.js');
    if (!fs.existsSync(adapterPath)) missing.push('adapters/muse.js');

    let registered = false;
    if (fs.existsSync(mapPath)) {
        const src = fs.readFileSync(mapPath, 'utf8');
        registered = /key:\s*'muse'/.test(src) && /AgentChat-Muse/.test(src);
    }

    let onChain = false;
    let adapterOk = false;
    let chainErr = null;
    try {
        const { PROVIDER_CHAIN, PROVIDER_KEYS } = require(chainPath);
        onChain = PROVIDER_KEYS.includes('muse')
            && PROVIDER_CHAIN.some(p => p.key === 'muse' && /muse\.ai/.test(p.url || ''));
        const adapter = require(adapterPath);
        adapterOk = adapter && adapter.key === 'muse'
            && Array.isArray(adapter.editorSelectors)
            && Array.isArray(adapter.responseSelectors);
    } catch (e) {
        chainErr = e && e.message ? e.message : String(e);
    }

    // Language guard: SKILL must NOT claim Muse is outside PROVIDER_CHAIN
    let skillWordingOk = false;
    if (fs.existsSync(skillMd)) {
        const md = fs.readFileSync(skillMd, 'utf8');
        const plain = md.replace(/[*`]+/g, '');
        const bad = /Not a chat LLM provider|Do not add Muse to PROVIDER_CHAIN/i.test(plain);
        const good = /IS on (?:OneWeb )?PROVIDER_CHAIN/i.test(plain)
            || /on the OneWeb PROVIDER_CHAIN/i.test(plain)
            || /on PROVIDER_CHAIN/i.test(plain);
        skillWordingOk = !bad && good;
    }

    log(`smoke: SKILL.md=${fs.existsSync(skillMd) ? 'ok' : 'MISSING'}`);
    log(`smoke: index.js=${fs.existsSync(indexJs) ? 'ok' : 'MISSING'}`);
    log(`smoke: productMap muse entry=${registered ? 'ok' : 'MISSING'}`);
    log(`smoke: PROVIDER_CHAIN muse=${onChain ? 'ok' : 'MISSING'}${chainErr ? ' err=' + chainErr : ''}`);
    log(`smoke: adapters/muse.js=${adapterOk ? 'ok' : 'MISSING'}`);
    log(`smoke: SKILL wording (on chain)=${skillWordingOk ? 'ok' : 'BAD'}`);

    const ok = !missing.length && registered && onChain && adapterOk && skillWordingOk;
    return {
        mode: 'smoke',
        ok,
        missing,
        registered,
        on_provider_chain: onChain,
        adapter_ok: adapterOk,
        skill_wording_ok: skillWordingOk,
        error: chainErr || undefined,
    };
}

function runDoctor() {
    const smoke = runSmoke();
    const packRoot = '/workspace/archive/2026-09/social-secondary-2026-09-27';
    const warnings = [];
    if (fs.existsSync(packRoot)) {
        try {
            const st = fs.statSync(packRoot);
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
        else if (args.workerPlan) summary = printWorkerPlan();
        else if (args.promptTemplate) summary = printPromptTemplate();
        else if (args.handoff) summary = printHandoff();
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
            on_provider_chain: true,
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

module.exports = {
    parseArgs,
    printOpsChecklist,
    printWorkerPlan,
    printPromptTemplate,
    printHandoff,
    EXAMPLE_THREADS,
};
