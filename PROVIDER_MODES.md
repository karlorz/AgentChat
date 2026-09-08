# Provider mode toggles plan (thinking / web search / deep research)

Status: Phase A implemented + live-verified (Grok, Kimi) on 2026-09-08;
ChatGPT DR implemented, live test pending (chatgpt.com tab closed).
Changes uncommitted in working tree.

## Scope — top 5 of PROVIDER_CHAIN (skills/lib/providers/chain.js)

1. gemini → 2. chatgpt → 3. claude → 4. **grok** → 5. kimi

(2026-09-08 change: grok.com replaced qwen at #4 on user decision; qwen moved
to #6, still in the chain. index.js PROVIDER_KEYS must mirror chain.js —
both are edited together. grok.com mode map: thinking→Expert in the
Auto/Fast/Expert/Heavy selector (Heavy is paid, never selected),
web search→DeepSearch chip, deep research→DeeperSearch (opt-in).)

## Design principles

- **Thinking + web search: default ON, per-provider opt-out env var.**
  `AGENTCHAT_<PROVIDER>_NO_THINK=1`, `AGENTCHAT_<PROVIDER>_NO_WEB_SEARCH=1`
  (mirrors the shipped ChatGPT pattern).
- **Deep research: default OFF, two opt-in paths.**
  - Global env: `AGENTCHAT_<PROVIDER>_DEEP_RESEARCH=1`.
  - Per-call, agent-selectable: the calling agent/CLI marks a single run as
    research-heavy (e.g. OneWeb `--deep-research` flag → executor option →
    adapter). Per-call wins over env unset; env `=0` cannot block an explicit
    per-call request.
  - Deep research runs 5–30 min: any DR activation must set a
    `providerTimeoutOverride` (≥1800s) or the 180s budget SIGKILLs the call
    (this already happened once with Kimi deep-think).
- Adapters verify-by-effect and fail-closed: if a toggle's state cannot be
  proven, do not blind-click; log and continue with the provider's default.
- One insert path per mode — no double-apply (ChatGPT chip lesson).

## Current state (investigated 2026-09-08)

| Provider | Thinking | Web search | Deep research |
|---|---|---|---|
| gemini | Done: Extended Thinking default via model switch; Pro opt-in `AGENTCHAT_GEMINI_MODEL=pro` (360s override) | n/a — grounding built in, no per-message toggle | UI exists, not wired |
| chatgpt | Done: default-on, `AGENTCHAT_CHATGPT_NO_THINK=1` | Done: default-on mention chip, `AGENTCHAT_CHATGPT_NO_WEB_SEARCH=1` | Plus-menu row "Deep research" seen live, not wired |
| claude | none | none (postResponseHook only strips placeholders) | none |
| qwen | none | none | none |
| kimi | STALE: old 快速模式/深度思考 chips gone; new UI = mode dropdown Instant(default)/K3/K3-Swarm + "Thinking effort" High/Standard (live-probed) | No standalone chip in new UI; search baked into K3 modes | Sidebar "Deep Research" entry, not wired |

Kimi's `ensureKimiFastMode` / `ensureKimiDeepThinkOff` target the retired UI
and are now likely silent no-ops — re-map, don't just extend.

## Phase A (done 2026-09-08)

1. Shared plumbing: `--deep-research` CLI flag (OneWeb), executor
   `callOpts.deepResearch` + `runChain` 4th-param opts, demo `/api/ask`
   `deepResearch` body param, function-valued `providerTimeoutOverride`
   (1800s when DR active).
2. Kimi re-mapped to new UI (Instant/K3/K3-Swarm dropdown + Thinking effort
   High/Standard; DR via sidebar). Retired 快速模式/深度思考 logic.
   Live-verified: mode+effort detection reads "Instant High" correctly.
3. ChatGPT deep research opt-in (plus-menu "Deep research" row, supersedes
   web-search chip). Unit-tested; live test pending a chatgpt.com tab.
4. Grok adapter (new, chain #4, qwen→#6): Expert mode default-on via
   aria-label="Model select" trigger + role="menuitemradio" items (Radix
   needs real locator clicks — el.click() no-ops). Live-verified end-to-end:
   Expert activated, answer extracted from .response-content-markdown.
   Live finding: no DeepSearch/DeeperSearch control on free account —
   helpers fail-soft with a log line; grok.com auto-grounds.

Gotcha worth remembering: Playwright `page.evaluate(fn, a, b)` throws
"Too many arguments" — always wrap extra args in one object. Both subagent
implementations hit this; fixed in review.

## Phase B (blocked until user reopens Gemini/Claude/Qwen tabs in CDP:9222)

5. Live-probe claude.ai composer: extended thinking / web search / research
   controls, then implement with opt-out env vars.
6. Live-probe qianwen.com composer (深度思考 / 联网搜索 / 深入研究), implement.
7. Gemini: verify current model-switch still matches UI; add DR opt-in if the
   UI entry is automatable on the free tier.
8. Live-test each provider end-to-end via demo/webextended.html, one provider
   at a time; /simplify; commit per provider.

## Verification rules

- Unit: zero-dep runner `node test/run.js` (jsdom), one test file per adapter
  (pattern: skills/lib/test/test_chatgpt_composer_toggles.js).
- Live: CDP 9222 only, never close user tabs, never type passwords; demo page
  hard-reload before each test (server sends Cache-Control: no-store).
