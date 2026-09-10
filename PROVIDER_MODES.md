# Provider mode toggles plan (thinking / web search / deep research)

Status: Phase A implemented + live-verified (Grok, Kimi) 2026-09-08 (commit
470dd9d). Phase B implemented + live-verified (Claude, Gemini) 2026-09-09;
ChatGPT DR live test in progress; Qwen blocked on user login (QR wall).

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
| gemini | Done + re-verified live 2026-09-09 on zh-HK UI: "3.8 Flash" + Extended Thinking default via model switch; Pro opt-in `AGENTCHAT_GEMINI_MODEL=pro` (360s override) | n/a — grounding built in, no per-message toggle | Not available on free tier (tools menu has uploads only) — not wired |
| chatgpt | Done: default-on, `AGENTCHAT_CHATGPT_NO_THINK=1` | Done: default-on mention chip, `AGENTCHAT_CHATGPT_NO_WEB_SEARCH=1` | Done: opt-in plus-menu "Deep research" row, supersedes web-search chip |
| claude | Done 2026-09-09: default-on Thinking checkbox in model menu → Effort submenu, `AGENTCHAT_CLAUDE_NO_THINK=1`; effort opt-in `AGENTCHAT_CLAUDE_EFFORT=low|medium|high` (Extra/Max never auto-selected — "3.5× or more usage") | Done 2026-09-09: default-on + menu menuitemcheckbox (account-persisted, no composer chip), `AGENTCHAT_CLAUDE_NO_WEB_SEARCH=1` | Wired opt-in, fail-soft: no Research row in + menu on free plan |
| qwen | Done (probed live 2026-09-10): mode menu ("快速" default / "思考研究"); no standalone thinking toggle on free tier (generic search fail-soft), opt-out `AGENTCHAT_QWEN_NO_THINK=1`; no free-tier model picker | Done: no web search toggle on free tier (grounding is automatic; generic search fail-soft), opt-out `AGENTCHAT_QWEN_NO_WEB_SEARCH=1` | Done: opt-in via `AGENTCHAT_QWEN_DEEP_RESEARCH=1` or `--deep-research` activating "思考研究" mode menu item; 1800s timeout override |
| kimi | Done: re-mapped to new UI (Instant/K3/K3-Swarm + Thinking effort High/Standard); live-verified | No standalone chip in new UI; search baked into K3 modes | Sidebar "Deep Research" entry, opt-in wired |

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

## Phase B (done 2026-09-09)

5. Claude adapter preInputHook (skills/lib/providers/adapters/claude.js):
   `dismissClaudeBlockingDialog` → `ensureClaudeWebSearchOn` →
   `ensureClaudeThinkingOn` → `ensureClaudeEffort` → `ensureClaudeResearchOn`,
   each fail-soft; `providerTimeoutOverride` via shared
   `isDeepResearchActive('claude')` / `DEEP_RESEARCH_TIMEOUT_MS`.
   Live-verified end-to-end: "Web search already active", "Thinking already
   active", answer extracted. Test file: skills/lib/test/test_claude_modes.js
   (17 cases).
6. Qwen: live-probed anonymously — send click triggers a QR login modal
   ("用千问APP扫码登录"). No anonymous usage; mode work blocked until the
   user logs into qianwen.com in the debug Chrome.
7. Gemini: existing model-switch re-verified live on a zh-HK UI
   ("開模式選擇器" button, 延伸思考 menu item — `EXTENDED_THINKING_RE` and
   `data-mode-id` selectors are locale-proof). No Deep Research entry in the
   free-tier tools menu (uploads only) — DR not wired.
8. ChatGPT DR: live-tested end-to-end with `--deep-research`. The "+" menu
   is a custom role-less popup (plain div/span rows) that needs REAL mouse
   clicks (page.mouse, not locator clicks); the DR row is found by text with
   viewport + trigger-proximity geometry (menu opens UP from the bottom chat
   composer but DOWN from the centered home composer; sidebar chat titles
   like "Deep research…" are excluded by an x-band around the trigger).
   Verified: "Deep research" inline pill inserted, sent with the message,
   answer returned (free tier's lightweight DR completes in well under a
   minute for simple queries). Factory hardening from this pass: quota scan
   now reads <main> instead of body (sidebar chat titles like "Compare Free
   Tier Limits" false-positive'd /free\s*(plan|tier)\s*limit/i and skipped a
   healthy provider); CLOSE_BTN_SEL gained "Not now".

Phase B live lessons (both cost a failed run):
- Playwright `locator.isVisible({ timeout })` does NOT wait — the timeout
  option is ignored; it is an immediate check. Base UI menus animate in over
  ~300–800ms, so menu-item probes must use `waitFor({state:'visible'})` (see
  `waitVisible` helper in claude.js).
- Playwright `hasText` regexes break on `\b` word boundaries (regex is
  serialized into the selector engine) — `/\bEffort\b/i` matched 0 of a
  visible "Effort Medium" row; `/Effort/i` matches. `^` anchors are fine
  (leading whitespace is normalized away first).
- Claude announcement modals ("Review updates to Claude's memory") render
  `#portal-root [data-base-ui-inert]`, which intercepts ALL pointer events
  and is NOT closed by Escape — dismiss via the safe "Not now" button (never
  "Save preferences"). Factory CLOSE_BTN_SEL now includes "Not now".

## Captcha / risk-control walls (attended-only)

- CN providers (observed on ChatGLM) may gate a tab with a slider
  ("Please slide to verify", `.captcha-content-container`). This is
  anti-automation risk control — NEVER automate the slide; behavioral
  detection fails silently later and risks the account.
- Designed handling: the classifier reports the tab as not-ready/auth and the
  fallback chain skips to the next provider. Record as skipped, never as a
  secret/credential failure.
- Resolution is attended: the user slides once in the debug Chrome tab; the
  session then passes. Observed 2026-09-10: the wall recurred ~40 min after a
  manual slide when automated sends resumed — expect recurrence, keep sends
  on the persistent warm tab.

## Verification rules

- Unit: zero-dep runner `node test/run.js` (jsdom), one test file per adapter
  (pattern: skills/lib/test/test_chatgpt_composer_toggles.js).
- Live: CDP 9222 only, never close user tabs, never type passwords; demo page
  hard-reload before each test (server sends Cache-Control: no-store).
