#!/usr/bin/env node
/**
 * AgentChat 可视化演示服务器
 *
 * 启动一个本地 HTTP 服务器，提供 Web 界面来演示 AgentChat 的多 AI Provider 能力。
 * 零额外依赖 — 仅使用 Node.js 内置模块。
 *
 * 用法:
 *   node scripts/demo_server.js
 *   然后打开浏览器访问 http://localhost:3456
 *
 * 前提: Chrome CDP 必须在 9222 端口运行
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// 会话上下文管理器 — 多轮对话降级时自动传递历史给 fallback Provider
const { getContext, addTurn, generateSummary, clearSession, getSessionData } = require('./lib/session_context');
// 共享 CDP 生命周期 — demo 服务器不再拥有独立的 Chrome 启动逻辑
const cdp = require('../skills/lib/cdp.js');
const { PROVIDER_CHAIN } = require('../skills/lib/providers/chain');
const { productMap } = require('../skills/lib/providers/productMap');
const { createExecutor } = require('../skills/lib/execute');

const PORT = 3456;
const PROJECT_DIR = path.resolve(__dirname, '..');
const WEBEXT_INDEX = path.join(PROJECT_DIR, 'skills', 'AgentChat-OneWeb', 'index.js');
const NODE_EXE = process.execPath;
const PROVIDER_KEYS = PROVIDER_CHAIN.map(p => p.key);
const PRODUCT_MAP = productMap();

const executor = createExecutor({
    webextPath: WEBEXT_INDEX,
    logPrefix: 'demo',
    holdLockOnSuccess: false,
});

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.png': 'image/png',
    '.json': 'application/json; charset=utf-8',
};

// ── CDP Health Check + Auto-Restart ────────────────────────────────────────

const CDP_PORT = process.env.CDP_PORT || 9222;
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

function cdpCheck() {
    return new Promise((resolve) => {
        const req = http.get(`${CDP_URL}/json/version`, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => resolve({ ok: true, data }));
        });
        req.on('error', () => resolve({ ok: false }));
        req.setTimeout(3000, () => { req.destroy(); resolve({ ok: false }); });
    });
}

async function ensureCdp(timeoutMs = 30000) {
    // 委托给共享 CDP 模块：它按需通过共享生命周期引擎（run-helper.cmd /
    // chrome-debug）启动 Chrome，必要时回退到内置启动器；绝不注册
    // 重启 watcher，也不写独立的进程/ownership 状态。
    const log = (m) => console.log(`[demo] ${m}`);
    const result = await cdp.ensureChromeCdp(CDP_URL, log);
    if (result.up) {
        console.log('[demo] Chrome CDP 已就绪');
        return true;
    }
    console.log('\n[demo] ⚠️  Chrome CDP 启动失败或超时 — 部分功能可能不可用');
    if (result.reason) console.log(`[demo] 原因: ${result.reason}`);
    return false;
}

async function callWebext(prompt, opts = {}) {
    let chain = PROVIDER_KEYS;
    if (opts.from) {
        const idx = PROVIDER_KEYS.indexOf(String(opts.from).toLowerCase());
        if (idx >= 0) chain = PROVIDER_KEYS.slice(idx);
    }
    const result = await executor.runChain(chain, prompt, opts.timeout || 600000, { deepResearch: !!opts.deepResearch });
    const provider = result.provider_used || '';
    const fallback = result.degradation && result.degradation.fallback_chain;
    return {
        response: result.response || result.error || '',
        provider,
        model: '',
        timeMs: result.elapsed_ms || 0,
        chain: fallback
            ? fallback.concat(provider ? [provider] : [])
            : (provider ? [provider] : []),
        success: !!result.success,
    };
}

function callSmoke() {
    return new Promise((resolve) => {
        const child = spawn(NODE_EXE, [WEBEXT_INDEX, '--smoke'], {
            cwd: PROJECT_DIR,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('close', () => {
            const providers = [];
            for (const line of stderr.split('\n')) {
                let m = line.match(/(\w[\w\s]*):\s*(✅|❌|REACHABLE|UNREACHABLE|needs login)/i);
                if (m) {
                    providers.push({ name: m[1].trim(), status: m[2].trim() });
                    continue;
                }
                m = line.match(/(\w[\w\s]*):\s*tab already open/i);
                if (m) {
                    providers.push({ name: m[1].trim(), status: '✅ (tab ready)' });
                }
            }
            resolve(providers);
        });
    });
}

// ── HTTP Server ─────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    // Malformed paths (e.g. "//") must never crash the server: 400, not throw.
    let url;
    try {
        url = new URL(req.url, `http://localhost:${PORT}`);
    } catch (_) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Bad Request');
    }

    // Helper: read request body safely (handles multi-byte UTF-8 split across TCP chunks)
    function readBody(req) {
        return new Promise((resolve) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
    }

    // API: POST /api/ask
    // 支持可选 sessionId — 多轮对话降级时自动注入历史上下文到 fallback
    if (req.method === 'POST' && url.pathname === '/api/ask') {
        const body = await readBody(req);
        try {
            const { prompt, provider, sessionId, deepResearch } = JSON.parse(body);
                if (!prompt || prompt.trim().length < 2) {
                    throw new Error('Prompt too short');
                }

                // 会话模式：将之前的对话上下文注入 prompt（降级时 fallback 可见）
                let fullPrompt = prompt.trim();
                let ctxInfo = null;
                if (sessionId) {
                    const ctx = getContext(sessionId);
                    if (ctx) {
                        fullPrompt = ctx + '当前问题: ' + fullPrompt;
                        ctxInfo = { sessionId, hasContext: true };
                    }
                }

                const result = await callWebext(fullPrompt, {
                    from: provider || 'gemini',
                    timeout: 600000,
                    provTimeout: 180000,
                    deepResearch: !!deepResearch,
                });

                // 会话模式：成功响应后保存对话记录
                if (sessionId && result.success && result.response) {
                    addTurn(sessionId, prompt.trim(), result.response);

                    // 异步生成摘要（长对话 ≥4 轮时）
                    const data = getSessionData(sessionId);
                    if (data && data._summaryPending && data.turns.length >= 4) {
                        // 不阻塞响应，fire-and-forget
                        generateSummary(sessionId, (sp) => {
                            return callWebext(sp, {
                                from: 'kimi',
                                timeout: 60000,
                                provTimeout: 30000,
                            }).then(r => r.response).catch(() => null);
                        }).catch(() => {});
                    }
                }

                if (ctxInfo) result.session = ctxInfo;
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(result));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                success: false,
                response: `Error: ${e.message}`,
                provider: '',
                model: '',
                timeMs: 0,
                chain: [],
            }));
        }
        return;
    }

    // API: GET /api/smoke
    if (req.method === 'GET' && url.pathname === '/api/smoke') {
        try {
            const providers = await callSmoke();
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(providers));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify([]));
        }
        return;
    }

    // API: GET /api/health — CDP status check
    if (req.method === 'GET' && url.pathname === '/api/health') {
        const cdp = await cdpCheck();
        res.writeHead(cdp.ok ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            cdp: cdp.ok ? 'online' : 'offline',
            port: CDP_PORT,
            server: 'running',
            providers: PRODUCT_MAP.providers,
            skills: PRODUCT_MAP.skills,
            languages: PRODUCT_MAP.languages,
        }));
        return;
    }

    // API: POST /api/parallel — FreeSubAgent 4-worker parallel decomposition
    if (req.method === 'POST' && url.pathname === '/api/parallel') {
        const body = await readBody(req);
        try {
            const { tasks } = JSON.parse(body);
            if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
                throw new Error('Need a tasks array with at least 1 task');
            }

            const results = [];
            const startTime = Date.now();

            // Run each task in sequence (to avoid overwhelming Chrome)
            for (const task of tasks) {
                try {
                    const r = await callWebext(task.prompt, {
                        from: task.provider || 'gemini',
                        timeout: 300000,
                        provTimeout: 120000,
                    });
                    results.push({ id: task.id, role: task.role, ...r, error: null });
                } catch (e) {
                    results.push({ id: task.id, role: task.role, success: false, response: '', error: e.message });
                }
            }

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                success: results.some(r => r.success),
                totalMs: Date.now() - startTime,
                completed: results.filter(r => r.success).length,
                total: tasks.length,
                results,
            }));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: POST /api/search-web — Kimi 联网搜索
    if (req.method === 'POST' && url.pathname === '/api/search-web') {
        const body = await readBody(req);
        try {
            const { query } = JSON.parse(body);
            if (!query) throw new Error('Need a search query');
            const r = await callWebext(
                `请进行联网搜索，用要点列出关键事实和数据。不要运行代码。\n\n搜索内容：${query}`,
                { from: 'kimi', timeout: 300000, provTimeout: 180000 }
            );
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(r));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, response: e.message }));
        }
        return;
    }

    // API: POST /api/deep-reason — Gemini Pro Extended 深度推理
    if (req.method === 'POST' && url.pathname === '/api/deep-reason') {
        const body = await readBody(req);
        try {
            const { prompt, context } = JSON.parse(body);
            const full = context
                ? `${prompt}\n\n基于以下资料进行推理分析，不需要搜索新资料：\n${context}`
                : prompt;
            const r = await callWebext(full, { from: 'gemini', timeout: 600000, provTimeout: 300000 });
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(r));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, response: e.message }));
        }
        return;
    }

    // API: POST /api/review — ChatGPT 交叉审查
    if (req.method === 'POST' && url.pathname === '/api/review') {
        const body = await readBody(req);
        try {
            const { content } = JSON.parse(body);
            if (!content) throw new Error('Need content to review');
            const r = await callWebext(
                `请逐一审查以下内容，列出所有问题点并给出具体修改建议。不要重写整个方案。\n\n${content}`,
                { from: 'chatgpt', timeout: 300000, provTimeout: 180000 }
            );
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(r));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, response: e.message }));
        }
        return;
    }

    // API: POST /api/verify — Qwen 事实核查
    if (req.method === 'POST' && url.pathname === '/api/verify') {
        const body = await readBody(req);
        try {
            const { content } = JSON.parse(body);
            if (!content) throw new Error('Need content to verify');
            const r = await callWebext(
                `请对你提供的内容进行事实核查。每个结论标注信息来源。\n\n${content}`,
                { from: 'qwen', timeout: 300000, provTimeout: 180000 }
            );
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(r));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, response: e.message }));
        }
        return;
    }

    // API: GET /api/stats — server uptime + call statistics
    if (req.method === 'GET' && url.pathname === '/api/stats') {
        const cdp = await cdpCheck();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            cdp: cdp.ok ? 'online' : 'offline',
            port: CDP_PORT,
            providers: PRODUCT_MAP.providers.length,
            skills: PRODUCT_MAP.skills.length,
            languages: PRODUCT_MAP.languages.length,
            uptime: process.uptime(),
        }));
        return;
    }

    // API: GET /api/sessions — 列出所有会话
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
        try {
            const sessionsDir = path.join(require('os').homedir(), '.agentchat', 'sessions');
            const files = require('fs').existsSync(sessionsDir)
                ? require('fs').readdirSync(sessionsDir).filter(f => f.endsWith('.json'))
                : [];
            const sessions = files.map(f => {
                const id = f.replace('.json', '');
                const data = getSessionData(id);
                return {
                    id,
                    turns: data.turns.length,
                    hasSummary: !!data.summary,
                    createdAt: data.createdAt,
                    updatedAt: data.updatedAt,
                };
            }).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(sessions));
        } catch (_) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify([]));
        }
        return;
    }

    // API: DELETE /api/sessions/{id} — 清除指定会话
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/sessions/')) {
        const sessionId = url.pathname.split('/api/sessions/')[1];
        clearSession(sessionId);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ cleared: true, sessionId }));
        return;
    }

    // Static: serve from demo/ directory
    let demoDir = path.join(PROJECT_DIR, 'demo');
    let filePath = path.join(demoDir, 'index.html');
    let staticPath = url.pathname.replace(/^\//, '');
    if (staticPath && staticPath !== 'index.html') {
        let candidate = path.join(demoDir, staticPath);
        if (require('fs').existsSync(candidate)) {
            filePath = candidate;
        }
    }

    try {
        const content = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'text/plain',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Pragma': 'no-cache',
        });
        res.end(content);
    } catch {
        res.writeHead(404);
        res.end('Not found');
    }
});

// ── 启动：先确保 CDP 在线，再开 HTTP 服务 ──

(async () => {
    const cdpReady = await ensureCdp();

    server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
            console.log(`[demo] 端口 ${PORT} 被占用，自动清理...`);
            const { execSync } = require('child_process');
            try {
                if (process.platform === 'win32') {
                    execSync(`netstat -ano | findstr :${PORT}`, { encoding: 'utf8' })
                        .split('\n').forEach(line => {
                            const m = line.trim().match(/(\d+)\s*$/);
                            if (m) { try { process.kill(parseInt(m[1])); } catch(_){} }
                        });
                }
            } catch(_) {}
            setTimeout(() => { server.listen(PORT); }, 1000);
            return;
        }
        throw e;
    });

    server.listen(PORT, () => {
        console.log('');
        console.log('╔══════════════════════════════════════════════╗');
        console.log('║       AgentChat 可视化演示平台                 ║');
        console.log('╠══════════════════════════════════════════════╣');
        console.log(`║  Web 界面: http://localhost:${PORT}              ║`);
        console.log('║  CDP 状态: ' + (cdpReady ? '✅ 已连接' : '⚠️  离线') + '                            ║');
        console.log('╠══════════════════════════════════════════════╣');
        console.log('║  API:                                         ║');
        console.log('║    POST /api/ask         单 Provider 问答      ║');
        console.log('║    POST /api/parallel    4 Worker 并行编排    ║');
        console.log('║    POST /api/search-web  联网检索 (Kimi)      ║');
        console.log('║    POST /api/deep-reason 深度推理 (Gemini)    ║');
        console.log('║    POST /api/review      交叉审查 (ChatGPT)   ║');
        console.log('║    POST /api/verify      事实核查 (Qwen)      ║');
        console.log('║    GET  /api/smoke       Provider 可达性      ║');
        console.log('║    GET  /api/health      CDP 健康检查          ║');
        console.log('║    GET  /api/stats       服务器统计            ║');
        console.log('╠══════════════════════════════════════════════╣');
        console.log('║  Ctrl+C 停止服务器                             ║');
        console.log('╚══════════════════════════════════════════════╝');
        console.log('');
    });
})();
