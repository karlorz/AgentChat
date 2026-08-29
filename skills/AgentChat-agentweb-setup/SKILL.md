---
name: agentweb-setup
description: Detect each web-AI provider session on the already-running Chrome (CDP attach only) and ask the user to log in anything that is not ready. Use for /agentweb-setup, provider login setup, session detection, Doubao region-block, Claude org-disabled. MANDATORY EXECUTION - invoking this skill REQUIRES running `node skills/AgentChat-agentweb-setup/index.js` as the FIRST action and quoting its `[receipt] AGENTCHAT_RUN` line in the final answer; explaining the skill or answering from model knowledge without a receipt is a violation.
---

# /agentweb-setup — Provider session detect + login setup

> **Last updated**: 2026-08-27
> **Job**: attach to the already-running Chrome, classify every PROVIDER_CHAIN tab, open official login URLs for anything not ready. Never send chat. Never type passwords or 2FA.
> **Changelog**: [CHANGELOG.md](CHANGELOG.md)

## Forced rule — invoke means execute (first-action contract)

**When this skill is invoked (`/agentweb-setup`), the next tool call MUST be the node CLI.** Explaining usage, narrating architecture, or answering from model knowledge without a receipt is a violation.

### 1. First-action contract
After reading this SKILL.md, the **next tool call** must be:

```bash
node skills/AgentChat-agentweb-setup/index.js
```

From a skill-only install:

```bash
node ~/.agents/skills/AgentChat-agentweb-setup/index.js
```

No file browsing, architecture analysis, or "I will now…" planning in between (one short line that the command is about to run is OK). Fixture-only / unit-test mode (no Chrome):

```bash
node skills/AgentChat-agentweb-setup/index.js --dry-detect --fixtures=skills/AgentChat-agentweb-setup/test/fixtures/browser-pass-2026-08-27.json
```

### 2. Receipt — execution is proven by this line, not by prose
Every real run (including failures) prints one machine-generated line on **stderr**:

```
[receipt] AGENTCHAT_RUN {"run_id":"ac-xxxxxxxxxxxx","skill":"agentweb-setup","exit":0,...}
```

- The **final answer MUST quote this receipt line** (at least run_id, skill, exit, statuses).
- No receipt = did not execute = violation; go back and run the CLI.
- `run_id` is random and appended to `skills/AgentChat-agentweb-setup/data/receipts.jsonl`. The user can `grep <run_id>` — a fabricated id will not match.
- Failed runs (exit≠0) still get a receipt: quote it and say why (CDP down / fixture missing / …).

### 3. Forbidden
- Reading SKILL.md then describing providers / CDP / region-ban without running `node index.js`
- Skipping the CLI because "I already know Gemini is ready"
- Claiming setup ran without a `[receipt] AGENTCHAT_RUN` line
- Starting a second Chrome, binding `:8737`, or launching `scripts/chrome-debug` from this skill
- Typing passwords, 2FA codes, or sending any chat message through a provider

### 4. Box / attach contract
- Attach only to the already-running Chrome via CDP. Default from `.env`: profile5, `127.0.0.1:9227`, `AGENTCHAT_NO_AUTOSTART=1`.
- If CDP is down: print official PROVIDER_CHAIN URLs, emit a failure receipt, stop. Do **not** autostart Chrome.

## What it classifies

Statuses are first-class (authDomains-only is **not** enough):

| Status | Meaning |
|--------|---------|
| `ready` | Signed in, composer usable, no blocking sidebar/org signals (2026-08-27 pass: Gemini + ChatGPT PONG) |
| `logged_out` | Login wall / sidebar 未登录 or 登录 / Access Verification captcha / guest composer + 登录 or Log in / auth URL. Composer alone is not enough. |
| `org_disabled` | Signed in but send is a no-op. Toast may be absent — send-probe / org check required. Visible editor is not ready (2026-08-27 live: Claude Free). |
| `quota` | Rate-limit / quota banner |
| `region_block_until_login` | Region interstitial that asks the user to log in first. **Required** for any provider that shows it. |

### Doubao region-ban (2026-08-27 proof)
`https://www.doubao.com/chat/` redirects to `https://www.doubao.com/security/doubao-region-ban?source=1` with copy “受区域限制，请先登录再使用豆包。你也可以选择使用 Dola。” and buttons 使用 Dola / 登录. That URL is **not** in `authDomains`. After the user logs in, **re-run** `/agentweb-setup` — the gate may lift.

## CLI

```bash
node skills/AgentChat-agentweb-setup/index.js
node skills/AgentChat-agentweb-setup/index.js --no-open
node skills/AgentChat-agentweb-setup/index.js --json
node skills/AgentChat-agentweb-setup/index.js --dry-detect --fixtures=skills/AgentChat-agentweb-setup/test/fixtures/browser-pass-2026-08-27.json
```

Live mode: attach CDP → scan PROVIDER_CHAIN tabs → print a classification table → for login-needed states, navigate the existing tab to the official PROVIDER_CHAIN URL; if status is not ready AND there is no tab, **open a new tab** on that official URL in the already-running Chrome (never a second Chrome / :8737 / chrome-debug). Detach only — never `browser.close()` on the shared profile5 CDP. Then emit receipt.

`--dry-detect` never opens Chrome. Use it in tests and when fixtures are passed.

## After the table
Ask the user to log in the suggested not-ready providers in the **existing** Chrome window. Do not type credentials. Then re-run the CLI to re-detect.
