/**
 * Provider session page-state classification.
 *
 * authDomains-only is NOT enough. Doubao (2026-08-27) redirects
 * https://www.doubao.com/chat/ →
 * https://www.doubao.com/security/doubao-region-ban?source=1
 * with copy “受区域限制，请先登录再使用豆包。你也可以选择使用 Dola。”
 * and buttons 使用 Dola / 登录 — that URL is NOT in PROVIDER_CHAIN
 * authDomains. After login the gate may lift; callers must re-detect.
 *
 * Statuses (product contract):
 *   ready | logged_out | org_disabled | quota | region_block_until_login
 * plus CLI-only `no_tab` when no provider tab is present.
 */

'use strict';

const { PROVIDER_CHAIN } = require('./chain');

const STATUSES = Object.freeze({
    READY: 'ready',
    LOGGED_OUT: 'logged_out',
    ORG_DISABLED: 'org_disabled',
    QUOTA: 'quota',
    REGION_BLOCK_UNTIL_LOGIN: 'region_block_until_login',
    NO_TAB: 'no_tab',
});

const LOGIN_NEEDED = new Set([
    STATUSES.LOGGED_OUT,
    STATUSES.REGION_BLOCK_UNTIL_LOGIN,
    STATUSES.NO_TAB,
]);

// Doubao 2026-08-27 proof — URL path + distinctive copy. Not a generic /login.
const REGION_BAN_URL_RE = /\/security\/doubao-region-ban|doubao-region-ban|\/region-ban(?:\?|$|\/)/i;
const REGION_BAN_TEXT_RE = /受区域限制，请先登录再使用豆包|受区域限制[\s\S]{0,80}请先登录|请先登录再使用豆包/;

const ORG_DISABLED_RE = /this organiz?ation has been disabled/i;

// ChatGLM 2026-08-27 live: sidebar-user-name is "登录" (or 未登录) with guest-avatar
// while a composer is still visible. Composer is NOT enough.
const SIDEBAR_LOGIN_NAME_RE = /^(未登录|登录|登入|Sign in|Log ?in)$/i;
const SIDEBAR_USER_NAME_HTML_RE = /sidebar-user-name[^>]*>\s*(登录|未登录|登入)\s*</i;
const HARD_LOGGED_OUT_RES = [
    /未登录/,
    /請先登入/,
];

// ChatGLM 2026-08-27 live: slide captcha "Access Verification" then login.
// Composer may exist underneath; still NOT ready.
const CAPTCHA_RES = [
    /access verification/i,
    /滑动验证/,
    /請完成驗證/,
    /请完成验证/,
    /安全验证/,
    /安全驗證/,
    /human verification/i,
    /slide to verify/i,
    /\bcaptcha\b/i,
];

const QUOTA_RES = [
    /额度.*(?:已|用).*(?:完|尽|满)/i,
    /quota\s*(?:exceeded|limit)/i,
    /次数.*(?:已|用).*(?:完|尽)/i,
    /reached your (?:daily )?limit/i,
    /you'?ve\s+(?:reached|hit).*(?:limit|cap)/i,
    /usage\s*(?:limit|cap|exceeded)/i,
    /rate\s*limit\s*(?:exceeded|reached)/i,
    /out\s*of\s*messages/i,
    /messages?\s*remaining[:\s]*0/i,
    /free\s*(?:plan|tier)\s*limit/i,
    /已达到.*(?:上限|限额|限制)/i,
    /已達到.*(?:上限|限額|限制)/i,
];

const LOGGED_OUT_TEXT_RES = [
    /未登录/,
    /請先登入/,
    /请先登录/,
    /登录后继续/,
    /登录以继续/,
    /登入後繼續/,
    /sign in to continue/i,
    /log ?in to continue/i,
    /please sign in/i,
    /session (?:has )?expired/i,
    /your session (?:has )?timed out/i,
    /会话已过期/,
    /登录已过期/,
];

const LOGIN_BUTTON_RE = /^(登录|登入|Sign in|Log ?in|Sign up|Log ?on|登录\/注册|立即登录)$/i;
const GEMINI_SIGNED_OUT_HREF_RE = /accounts\.google\.com\/(?:ServiceLogin|signin|AccountChooser)/i;

const ADAPTER_CACHE = Object.create(null);
function loadAdapter(key) {
    if (key in ADAPTER_CACHE) return ADAPTER_CACHE[key];
    try {
        ADAPTER_CACHE[key] = require(`./adapters/${key}`);
    } catch (_) {
        ADAPTER_CACHE[key] = null;
    }
    return ADAPTER_CACHE[key];
}

function findProvider(keyOrEntry) {
    if (keyOrEntry && typeof keyOrEntry === 'object' && keyOrEntry.key) return keyOrEntry;
    const key = String(keyOrEntry || '').toLowerCase();
    return PROVIDER_CHAIN.find(p => p.key === key) || null;
}

function getProviderHosts(provider) {
    if (!provider) return [];
    if (provider.tabHosts && provider.tabHosts.length) return provider.tabHosts.slice();
    try { return [new URL(provider.url).hostname]; } catch (_) { return []; }
}

function hostnameOf(url) {
    try { return new URL(url).hostname; } catch (_) { return ''; }
}

function isProviderHost(url, provider) {
    const host = hostnameOf(url);
    if (!host) return false;
    return getProviderHosts(provider).some(h => host === h || host.endsWith('.' + h));
}

function isAuthUrl(url, provider) {
    if (!url) return false;
    const domains = []
        .concat((provider && provider.authDomains) || [])
        .concat((loadAdapter(provider && provider.key) || {}).authDomains || []);
    if (domains.some(d => url.includes(d))) return true;
    try {
        const path = new URL(url).pathname || '';
        // Narrow path tokens — do NOT treat /security/doubao-region-ban as /login.
        return /\/(login|signin|sign-in|sign_in|signup|sign-up)(?:\/|$)/i.test(path)
            || /\/auth(?:\/|$)/i.test(path);
    } catch (_) {
        return false;
    }
}

function stripHtml(html) {
    return String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractButtonsFromHtml(html) {
    const buttons = [];
    const src = String(html || '');
    const re = /<(?:button|a)[^>]*>([\s\S]*?)<\/(?:button|a)>/gi;
    let m;
    while ((m = re.exec(src))) {
        const label = stripHtml(m[1]);
        if (label) buttons.push(label);
    }
    const ariaRe = /<(?:button|a|div|span)[^>]*aria-label=["']([^"']+)["'][^>]*>/gi;
    while ((m = ariaRe.exec(src))) {
        const label = String(m[1] || '').trim();
        if (label) buttons.push(label);
    }
    return buttons;
}

function normalizeSnapshot(raw) {
    const snap = raw && typeof raw === 'object' ? raw : {};
    const html = snap.html || '';
    let text = snap.text;
    let buttons = Array.isArray(snap.buttons) ? snap.buttons.slice() : null;
    if ((!text || !text.trim()) && html) text = stripHtml(html);
    if ((!buttons || !buttons.length) && html) buttons = extractButtonsFromHtml(html);
    return {
        url: snap.url || '',
        title: snap.title || '',
        text: String(text || '').replace(/\s+/g, ' ').trim(),
        html: html,
        buttons: buttons || [],
        hasEditor: !!snap.hasEditor,
        hasPassword: !!snap.hasPassword,
        sidebarUser: String(snap.sidebarUser || '').trim(),
        sidebarLoggedOut: !!snap.sidebarLoggedOut,
        orgDisabled: !!snap.orgDisabled,
        orgDisabledReason: snap.orgDisabledReason ? String(snap.orgDisabledReason) : '',
        orgHealthy: !!snap.orgHealthy,
        sendOk: !!snap.sendOk,
        sendNoop: !!snap.sendNoop,
        sendNoopReason: snap.sendNoopReason ? String(snap.sendNoopReason) : '',
        captcha: !!snap.captcha,
        present: snap.present !== false && !!(snap.url || snap.html || snap.text || snap.orgDisabled || snap.orgDisabledReason || snap.sidebarUser || snap.captcha || snap.sendNoop || snap.sendOk),
    };
}

function hasLoginButton(snap) {
    return (snap.buttons || []).some(b => LOGIN_BUTTON_RE.test(String(b).trim()));
}

function matchesAny(res, text) {
    if (!text) return null;
    for (const re of res) {
        const m = text.match(re);
        if (m) return m[0];
    }
    return null;
}

function matchesQuota(snap, provider) {
    const hit = matchesAny(QUOTA_RES, snap.text);
    if (hit) return hit;
    const adapter = loadAdapter(provider && provider.key);
    const extra = (adapter && adapter.quotaPatterns) || [];
    for (const re of extra) {
        try {
            const m = snap.text && snap.text.match(re);
            if (m) return m[0];
        } catch (_) { /* ignore bad adapter regex */ }
    }
    return null;
}

function looksGeminiSignedOut(snap) {
    return GEMINI_SIGNED_OUT_HREF_RE.test(snap.html || '')
        || GEMINI_SIGNED_OUT_HREF_RE.test(snap.url || '')
        || /accounts\.google\.com\/(?:ServiceLogin|signin|AccountChooser)/i.test(snap.text || '');
}

function sidebarLoginState(snap) {
    if (snap.sidebarLoggedOut) return 'sidebar logged-out';
    if (snap.sidebarUser && SIDEBAR_LOGIN_NAME_RE.test(snap.sidebarUser)) {
        return `sidebar user: ${snap.sidebarUser}`;
    }
    const html = snap.html || '';
    if (SIDEBAR_USER_NAME_HTML_RE.test(html)) return 'sidebar-user-name login CTA';
    if (/guest-avatar/i.test(html) && /sidebar-user-(?:name|entry|text)/i.test(html)) {
        return 'guest-avatar sidebar';
    }
    return null;
}

function orgDisabledEvidence(snap) {
    const hay = [snap.text, snap.html, snap.title, snap.orgDisabledReason].join('\n');
    const hit = hay.match(ORG_DISABLED_RE);
    if (hit) return hit[0];
    if (snap.orgDisabled) return 'organization disabled';
    if (snap.orgDisabledReason) return String(snap.orgDisabledReason);
    return null;
}

function captchaBlocked(snap) {
    if (snap.captcha) return 'captcha/blocked';
    const hit = matchesAny(CAPTCHA_RES, snap.text) || matchesAny(CAPTCHA_RES, snap.html) || matchesAny(CAPTCHA_RES, snap.title);
    return hit ? `captcha/blocked: ${hit}` : null;
}

function isLoggedOut(snap, provider) {
    if (isAuthUrl(snap.url, provider)) return 'auth url';
    if (snap.hasPassword) return 'visible password input';
    const cap = captchaBlocked(snap);
    if (cap) return cap;
    if (looksGeminiSignedOut(snap)) return 'gemini signed-out landing';
    // Sidebar login CTA beats a visible composer (ChatGLM 未登录 / 登录).
    const side = sidebarLoginState(snap);
    if (side) return side;
    const hardHit = matchesAny(HARD_LOGGED_OUT_RES, snap.text) || matchesAny(HARD_LOGGED_OUT_RES, snap.html);
    if (hardHit) return `text: ${hardHit}`;
    const textHit = matchesAny(LOGGED_OUT_TEXT_RES, snap.text);
    if (textHit) {
        // Long chat transcripts that merely discuss login are not walls.
        // Do NOT apply this exception to sidebar status tokens (未登录).
        if (snap.hasEditor && snap.text.length > 1500) return null;
        return `text: ${textHit}`;
    }
    // Qwen / Kimi 2026-08-27 live: guest composer works AND 登录 / Log in
    // is still shown. Guest composer is NOT ready for full fallback.
    if (hasLoginButton(snap)) return 'login button (guest composer is not ready)';
    return null;
}

/**
 * Claude 2026-08-27 live: signed in as Free, composer visible, send is a
 * silent no-op. There may be NO "This organization has been disabled" toast.
 * Visible editor + no toast is NOT ready. Require sendOk (send-probe) or
 * orgHealthy (account/org check).
 */
function claudeSendBlocked(snap, provider) {
    if (!provider || provider.key !== 'claude') return null;
    // The org API verdict is authoritative: api_disabled_reason === null means
    // healthy. A send-probe no-op on top of that is a probe artifact (fresh-tab
    // hydration, ProseMirror rejecting the synthetic insert), not a disabled org.
    if (snap.orgHealthy) return null;
    if (snap.sendNoop) return snap.sendNoopReason || 'send-probe no-op';
    if (snap.sendOk) return null;
    return 'claude send-probe/org check did not confirm send works';
}

/**
 * Classify one provider session snapshot.
 *
 * @param {object} raw  { url, title, text, html, buttons, hasEditor, hasPassword, present }
 * @param {object|string} providerOrKey  PROVIDER_CHAIN entry or key
 * @returns {{ status: string, evidence: string, loginUrl: string, needsLogin: boolean, ready: boolean }}
 */
function classifySession(raw, providerOrKey) {
    const provider = findProvider(providerOrKey);
    const snap = normalizeSnapshot(raw);
    const loginUrl = (provider && provider.url) || '';

    const done = (status, evidence) => ({
        status,
        evidence: evidence || '',
        loginUrl,
        needsLogin: LOGIN_NEEDED.has(status),
        ready: status === STATUSES.READY,
        providerKey: provider ? provider.key : (typeof providerOrKey === 'string' ? providerOrKey : ''),
        url: snap.url,
    });

    if (!snap.present && !snap.url) {
        return done(STATUSES.NO_TAB, 'no provider tab');
    }

    // 1. Region-block-until-login — MUST beat logged_out (page also says 请先登录).
    if (REGION_BAN_URL_RE.test(snap.url)) {
        return done(STATUSES.REGION_BLOCK_UNTIL_LOGIN, `region-ban url: ${snap.url}`);
    }
    const regionText = snap.text.match(REGION_BAN_TEXT_RE);
    if (regionText) {
        return done(STATUSES.REGION_BLOCK_UNTIL_LOGIN, `region-ban copy: ${regionText[0]}`);
    }

    // 2. Org disabled (Claude Free / disabled workspace) — send is a no-op.
    // MUST beat visible-editor ready (live 2026-08-27: composer shown, send no-op).
    const orgHit = orgDisabledEvidence(snap);
    if (orgHit) {
        return done(STATUSES.ORG_DISABLED, orgHit);
    }

    // 3. Quota / rate-limit banners.
    const quotaHit = matchesQuota(snap, provider);
    if (quotaHit) {
        return done(STATUSES.QUOTA, `quota: ${String(quotaHit).slice(0, 80)}`);
    }

    // 4. Logged out (URL path, copy, login buttons, password field).
    const lo = isLoggedOut(snap, provider);
    if (lo) {
        return done(STATUSES.LOGGED_OUT, lo);
    }

    // 5. Claude silent no-op — MUST beat visible-editor ready.
    // Do not treat visible editor + no toast as ready.
    const claudeHit = claudeSendBlocked(snap, provider);
    if (claudeHit) {
        return done(STATUSES.ORG_DISABLED, claudeHit);
    }

    // 6. Ready: visible composer, or provider-host tab with no blocking signals.
    if (snap.hasEditor) {
        return done(STATUSES.READY, 'visible chat editor');
    }
    if (isProviderHost(snap.url, provider) && !hasLoginButton(snap)) {
        return done(STATUSES.READY, `provider tab ${snap.url}`);
    }

    if (!snap.present) return done(STATUSES.NO_TAB, 'no provider tab');
    return done(STATUSES.LOGGED_OUT, 'no editor / no ready signal');
}

function classifyMany(snapshots) {
    return PROVIDER_CHAIN.map((provider) => {
        const snap = (snapshots && (snapshots[provider.key] || snapshots[provider.name])) || { present: false };
        return { provider, ...classifySession(snap, provider) };
    });
}

module.exports = {
    STATUSES,
    LOGIN_NEEDED,
    REGION_BAN_URL_RE,
    REGION_BAN_TEXT_RE,
    ORG_DISABLED_RE,
    classifySession,
    classifyMany,
    findProvider,
    getProviderHosts,
    isProviderHost,
    isAuthUrl,
    stripHtml,
    extractButtonsFromHtml,
    normalizeSnapshot,
    sidebarLoginState,
    orgDisabledEvidence,
    captchaBlocked,
    claudeSendBlocked,
    CAPTCHA_RES,
};
