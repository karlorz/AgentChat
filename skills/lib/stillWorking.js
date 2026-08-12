/**
 * stillWorking.js — shared multi-signal "generation still in progress" detector.
 *
 * WHY THIS EXISTS (Kimi 联网搜索 truncation, 2026-07):
 * Kimi's multi-step web search pipeline emits phase statuses the old
 * kimi.js tail regexes never covered — the char class 正在[搜索检索查询]
 * does not contain 获取, and "N 个网页" is not "N 个结果". During a
 * 5–30s page-fetch the response text is static longer than the 8s
 * stabilityWindow, so the factory declared completion mid-search. Two
 * field-observed truncation tails:
 *     "正在获取网页..."          (45s run,  960 chars)
 *     "获取网页 5 个网页"        (78s run, 1522 chars)
 * Neither matched any old pattern. The same failure class applies to
 * every provider with an agentic tool phase (MiniMax agent, DeepSeek R1
 * 深度思考折叠, Qwen deep search, MiMo), so the detector lives here as a
 * shared module instead of being re-fixed one adapter at a time.
 *
 * DESIGN — three OR'd signals, ordered cheap→expensive:
 *   S1 (zero CDP cost)  factory-supplied polled text tail looks like an
 *                       in-flight status line (textLooksBusy).
 *   S2 (1 evaluate)     a stop/pause control is visible (the send button
 *                       flips to a stop control while streaming) — the
 *                       strongest wording- and locale-independent signal.
 *   S3 (same evaluate)  a spinner/typing indicator is visible INSIDE the
 *                       last response container, or that container's own
 *                       text tail looks busy (covers the case where the
 *                       status lives in a tool card OUTSIDE the node the
 *                       factory happens to poll).
 *
 * FALSE-POSITIVE BUDGET: a wrong "busy" verdict can only DELAY completion,
 * and providerFactory.js v11 bounds that delay with
 * stillGeneratingMaxHoldMs (the ⚙ hold cap): once no REAL text change has
 * happened for that long, ⚙ resets are ignored and the normal stability
 * window takes over. So patterns here are tuned for recall (catch every
 * status wording) rather than precision — a miss truncates a response,
 * a false hit costs bounded seconds.
 */

'use strict';

// ── Text-tail classifier (pure, unit-testable) ──────────────────────────────

// Kimi renders thinking traces, search status and the final answer as
// SIBLING blocks inside the segment (flat DOM). The structural fix (prefer
// the answer-only .markdown-container in both the probe and the adapter's
// responseSelectors) keeps the thinking/search text out of the completion
// clock. This sanitizer is the defensive fallback for layouts where the
// container splits are unavailable — it only removes discrete post-answer
// footer lines, never the answer text itself.
const KIMI_UPGRADE_NOTICE_RE = /High demand\..*$/m;
const KIMI_REFERENCE_RE = /^\s*(?:Reference|參考資料|参考来源)\s*$/m;

/** Strip Kimi's post-answer upgrade/reference footer noise from a response. */
function cleanKimiMetaText(text) {
    if (!text) return '';
    return String(text)
        // Post-answer upgrade/upsell notice ("High demand. Switched to …").
        .replace(KIMI_UPGRADE_NOTICE_RE, '')
        // "Reference" footer heading (source chips follow it on later lines).
        .replace(KIMI_REFERENCE_RE, '')
        .split('\n').map(s => s.trim()).filter(Boolean).join('\n')
        .trim();
}

// Status chips are SHORT; real prose sentences are not. Only lines at or
// under this length are eligible to be classified as a status.
const STATUS_LINE_MAX = 48;
// How many trailing non-empty lines of the container text to inspect.
// Status cards sometimes render a couple of source-chip lines AFTER the
// status itself, so we look at a small tail window, not just the last line.
const TAIL_LINES = 6;

// Verb vocabulary for CJK tool-phase statuses. Deliberately broad — see
// FALSE-POSITIVE BUDGET above. 获取/抓取/阅读/浏览 are the fetch-phase verbs
// missing from the original kimi.js patterns.
const CN_VERBS =
    '搜索|检索|查询|获取|抓取|读取|阅读|浏览|访问|打开|解析|分析|整理|归纳|'
    + '总结|思考|推理|撰写|生成|调用|执行|等待|加载|联网';

const STATUS_PATTERNS = [
    // "正在获取网页…" / "正在搜索…" / "开始分析…" / "继续浏览…"
    new RegExp(`^(?:正在|开始|继续|准备)(?:${CN_VERBS})`),
    // "搜索中…" / "深度思考中" / "联网搜索中" — up to 4 CJK prefix chars
    new RegExp(`^[\\u4e00-\\u9fa5]{0,4}(?:${CN_VERBS})中(?:[.。…]{0,3})?$`),
    // "获取网页 5 个网页" / "已阅读 12 个网页" / "搜索到 8 条结果" / "5 个结果"
    new RegExp(
        `^(?:已|共)?(?:(?:${CN_VERBS})(?:了|到|网页|资料|来源|链接|结果)?)?`
        + `\\s*\\d+\\s*[个条篇]\\s*(?:网页|结果|来源|链接|页面|资料|文件)`
    ),
    // "让我再搜索一下" / "还需要更多资料"
    /^让我(?:再|先|继续)/,
    /^还需(?:要|更)/,
    // English tool-phase gerunds ("Searching the web", "Reading 5 pages…").
    // A short heading in a final answer can false-positive here — bounded
    // by the factory's ⚙ hold cap, see module header.
    /^(?:Searching|Browsing|Reading|Fetching|Crawling|Visiting|Opening|Gathering|Analyzing|Thinking|Reasoning|Running|Working)\b/i,
    /^\d+\s*(?:results?|sources?|pages?)\s*$/i,
];

/**
 * Does the TAIL of this text look like an in-flight tool/status line?
 * Inspects the last TAIL_LINES non-empty lines; only short lines qualify.
 *
 * @param {string} text - container innerText (full or tail slice)
 * @returns {boolean}
 */
function textLooksBusy(text) {
    if (!text) return false;
    const lines = String(text).split('\n').map(s => s.trim()).filter(Boolean);
    const tail = lines.slice(-TAIL_LINES);
    for (const line of tail) {
        if (line.length > STATUS_LINE_MAX) continue; // prose sentence, not a chip
        if (STATUS_PATTERNS.some(p => p.test(line))) return true;
    }
    return false;
}

// ── DOM-side probe (single page.evaluate) ────────────────────────────────────
// Runs in the page. RegExps cannot cross the evaluate boundary, so the DOM
// class/aria heuristics are self-contained string sources here; the TEXT
// classification stays in Node (textLooksBusy) on the returned tail.
function _domProbe({ sels }) {
    // PERF FIX (2026-07): getBoundingClientRect() + getComputedStyle() on
    // 1200 elements per poll caused forced layout reflows on kimi.com,
    // triggering IntersectionObserver-based auto-scroll → up/down oscillation
    // loop every 2s. Replaced with offsetParent — single property access,
    // catches display:none (the common hidden state) without reflow.
    // visibility:hidden / opacity:0 false-positives are bounded by the
    // factory's stillGeneratingMaxHoldMs cap, so the trade-off is safe.
    const visible = el => {
        try {
            if (!el) return false;
            return el.offsetParent !== null;
        } catch (_) { return false; }
    };

    // Last response container, honoring the ADAPTER's own selector order —
    // the probe must judge the same subtree family the factory polls. Kimi
    // renders thinking traces, tool-call steps and the final answer as
    // SIBLING blocks inside the segment; the status lines match
    // textLooksBusy and held the completion clock open after the real answer
    // rendered. When a markdown/answer container exists inside the host,
    // judge THAT instead of the whole segment (the answer's own tail drives
    // the clock).
    let host = null;
    for (const sel of sels || []) {
        let list;
        try { list = document.querySelectorAll(sel); } catch (_) { continue; }
        if (list && list.length) { host = list[list.length - 1]; break; }
    }
    // S3d — Kimi agentic tool phase: while the model is running tool calls,
    // the answer container stays EMPTY and the intermediate reasoning is
    // written into *toolcall* markdown blocks. The pre-answer text grows
    // with every step, so a live toolcall block means generation is still in
    // progress — hold the clock until the real answer renders (or the step
    // text stops growing for good, bounded by stillGeneratingMaxHoldMs).
    let toolPhaseBusy = false;
    if (host) {
        try {
            const tc = host.querySelector(
                '[class*="markdown-container"][class*="toolcall"]'
            );
            if (tc && (tc.textContent || '').trim().length > 0) {
                const answer = host.querySelector(
                    '[class*="markdown-container"]:not([class*="toolcall"]):not([class*="tool-call"])'
                );
                if (!answer || !(answer.textContent || '').trim()) {
                    toolPhaseBusy = true;
                }
            }
        } catch (_) { /* best-effort */ }
        if (!toolPhaseBusy) {
            const inner = host.querySelector(
                '[class*="markdown-container"]:not([class*="toolcall"]):not([class*="tool-call"])'
            );
            if (inner) host = inner;
        }
    }

    // PERF FIX (2026-07): narrowed from 'button, [role="button"]' (scanned
    // 400+ elements) to only elements whose class/aria suggests stop/pause —
    // reduces DOM queries from ~400 to <20, eliminating reflow storms.
    const STOPISH = /(?:^|[\s_-])(?:stop|pause)[-_]?(?:btn|button|icon|generat|answer|respon)|(?:^|[\s_-])generating(?:$|[\s_-])/i;
    const STOP_ARIA = /停止|stop\s*(?:generat|respon|answer)|暂停/i;
    let uiBusy = false;
    let scanned = 0;
    let ctrls;
    try {
        ctrls = document.querySelectorAll(
            '[class*="stop" i], [class*="pause" i], [class*="generat" i], [aria-label*="stop" i], [aria-label*="停止"], [aria-label*="暂停"]'
        );
    } catch (_) { ctrls = []; }
    for (const el of ctrls) {
        if (++scanned > 100) break;
        const aria = (el.getAttribute && (el.getAttribute('aria-label') || '')) || '';
        const cls = typeof el.className === 'string' ? el.className : '';
        if ((STOP_ARIA.test(aria) || STOPISH.test(cls)) && visible(el)) {
            uiBusy = true; break;
        }
    }

    // S3a: spinner / typing indicator INSIDE the last response container.
    // [^a-z] boundary (case-insensitive) keeps "download(ing)" from matching
    // "loading". camelCase boundaries are accepted misses — signals are OR'd.
    if (!uiBusy && host) {
        const SPIN = /(?:^|[^a-z])(?:loading|spinner|dot(?:ting)?[-_]?(?:flashing|typing|pulse)?|animate-spin|typing(?:[-_]?indicator)?|shimmer|skeleton|blinking?|cursor[-_]?blink)/i;
        let n = 0;
        let nodes;
        try { nodes = host.querySelectorAll('[class]'); } catch (_) { nodes = []; }
        for (const el of nodes) {
            if (++n > 200) break;
            const cls = typeof el.className === 'string' ? el.className : '';
            if (cls && SPIN.test(cls) && visible(el)) { uiBusy = true; break; }
        }
    }

    // PERF FIX (2026-07): host.innerText forces a full layout calculation
    // on the live DOM subtree → triggers kimi.com IntersectionObserver
    // auto-scroll → up/down oscillation loop. textContent reads the DOM
    // tree directly without layout computation. Trade-off: includes text
    // from hidden child elements, but we only use the tail for pattern
    // matching (textLooksBusy), so false positives are bounded by the
    // factory's stillGeneratingMaxHoldMs cap.
    const text = host ? (host.textContent || '') : '';
    return { uiBusy: uiBusy || toolPhaseBusy, toolPhaseBusy, tail: String(text).slice(-1500) };
}

/**
 * Build a stillGeneratingCheck for providerFactory.
 *
 * @param {object} opts
 * @param {string[]} opts.responseSelectors - SAME array the adapter hands the
 *        factory, so the probe and the stability poller judge the same
 *        container family (the old kimi.js check hardcoded selector [0] and
 *        silently diverged whenever the factory matched a fallback selector).
 * @returns {(page: import('playwright-core').Page, info?: {text?: string}) => Promise<boolean>}
 */
function makeStillWorkingCheck(opts = {}) {
    const sels = Array.isArray(opts.responseSelectors)
        ? opts.responseSelectors.slice()
        : [];
    const cleanText = typeof opts.cleanText === 'function' ? opts.cleanText : null;
    return async function stillWorkingCheck(page, info) {
        // S1 — zero-cost: classify the text the factory ALREADY read this
        // poll (perfectly aligned with the element driving the stability
        // clock). Factory v11 passes { text }; older callers pass nothing.
        if (info && typeof info.text === 'string') {
            const judged = cleanText ? cleanText(info.text) : info.text;
            if (textLooksBusy(judged)) return true;
        }
        // S2 + S3 — one CDP round-trip.
        let probe = null;
        try {
            probe = await page.evaluate(_domProbe, { sels });
        } catch (_) {
            return false; // page gone / CSP — never break the poller
        }
        if (!probe) return false;
        if (probe.uiBusy) return true;
        // S3b — the probe's host subtree can include tool/status cards that
        // sit OUTSIDE the factory-polled node; classify its tail too.
        if (typeof probe.tail === 'string' && probe.tail
            && probe.tail !== (info && info.text)) {
            const judged = cleanText ? cleanText(probe.tail) : probe.tail;
            return textLooksBusy(judged);
        }
        return false;
    };
}

module.exports = {
    textLooksBusy,
    makeStillWorkingCheck,
    cleanKimiMetaText,
    // exported for tests / diagnostics
    STATUS_PATTERNS,
    STATUS_LINE_MAX,
    TAIL_LINES,
    _domProbe,
};
