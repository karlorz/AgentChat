/**
 * PROVIDER_CHAIN — single source of truth for provider priority order.
 *
 * Extracted from AgentChat-OneWeb/index.js so that consumers that only
 * need the chain (e.g. IndependentTasks's buildFallbackChain) don't have to load
 * playwright-core + all 11 adapters just to read a constant array.
 *
 * OneWeb re-exports this for backward compatibility.
 */

const PROVIDER_CHAIN = [
    { key: 'gemini',   name: 'Gemini',   url: 'https://gemini.google.com/u/0/app', authDomains: ['accounts.google.com'],
      // Surfaced on reason='auth' failures — the ONE command that restores a
      // missing/logged-out Gemini tab in the shared Chrome (see connect-gemini.sh).
      recoveryHint: 'bash scripts/connect-gemini.sh  # 重连一次恢复 Gemini 登录态' },
    { key: 'chatgpt',  name: 'ChatGPT',  url: 'https://chatgpt.com/',               authDomains: ['auth.openai.com', 'chat.openai.com/auth'] },
    { key: 'claude',   name: 'Claude',   url: 'https://claude.ai/',                 authDomains: ['claude.ai/login', 'auth.anthropic.com'] },
    { key: 'grok',     name: 'Grok',     url: 'https://grok.com/',                  authDomains: ['accounts.x.ai', 'x.ai/login', 'grok.com/login', 'x.com', 'twitter.com'] },
    { key: 'kimi',     name: 'Kimi',     url: 'https://www.kimi.com/',              authDomains: ['kimi.moonshot.cn/login', 'kimi.com/login', 'moonshot.cn/login'], tabHosts: ['kimi.moonshot.cn', 'kimi.com'] },
    { key: 'qwen',     name: 'Qwen',     url: 'https://www.qianwen.com/?source=tongyigw', authDomains: ['qianwen.com/login', 'login.aliyun.com', 'signin.aliyun.com'] },
    { key: 'minimax',  name: 'MiniMax',  url: 'https://agent.minimaxi.com/',        authDomains: ['agent.minimaxi.com/login', 'minimax.com/login'] },
    { key: 'chatglm',  name: 'ChatGLM',  url: 'https://chatglm.cn/main/alltoolsdetail?lang=zh', authDomains: ['chatglm.cn/login', 'account.chatglm.cn'] },
    { key: 'doubao',   name: 'Doubao',   url: 'https://www.doubao.com/chat/',        authDomains: ['doubao.com/login', 'www.doubao.com/login'] },
    { key: 'mimo',     name: 'MiMo',     url: 'https://aistudio.xiaomimimo.com/',   authDomains: ['aistudio.xiaomimimo.com/login', 'auth0.com'] },
    { key: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/',         authDomains: ['chat.deepseek.com/login', 'deepseek.com/login'] },
];

/** Provider keys in chain order — derive lists from this instead of re-typing. */
const PROVIDER_KEYS = PROVIDER_CHAIN.map(p => p.key);

/** Display-name alternation for response cleaning (execute.js UI_CHROME_PATTERNS). */
const PROVIDER_NAMES_RE_SOURCE = `(?:${PROVIDER_CHAIN.map(p => p.name).join('|')})`;

/** Deep research runs take 5–30 min; the 180s default budget SIGKILLs them. */
const DEEP_RESEARCH_TIMEOUT_MS = 1_800_000;

/**
 * Deep research is opt-in, per provider env or the global per-run flag
 * (OneWeb --deep-research sets AGENTCHAT_DEEP_RESEARCH=1 for the process).
 */
function isDeepResearchActive(providerKey) {
    return process.env[`AGENTCHAT_${String(providerKey).toUpperCase()}_DEEP_RESEARCH`] === '1'
        || process.env.AGENTCHAT_DEEP_RESEARCH === '1';
}

module.exports = {
    PROVIDER_CHAIN,
    PROVIDER_KEYS,
    PROVIDER_NAMES_RE_SOURCE,
    DEEP_RESEARCH_TIMEOUT_MS,
    isDeepResearchActive,
};
