---
name: AgentChat-Muse
description: Muse.ai LLM / agent-worker subagent + OneWeb PROVIDER_CHAIN adapter (key muse). Use for Muse chat, research, and secondary social ops handoff. Draft-only live posture — ask Karl before SMS, prefer desktop Chrome on anti-bot Continue, never auto-post, never touch primary @karldigi X. MANDATORY EXECUTION — invoking this skill REQUIRES running `node skills/AgentChat-Muse/index.js` (or `~/.agents/skills/AgentChat-Muse/index.js`) as the FIRST action and quoting its `[receipt] AGENTCHAT_RUN` line; narrating without a receipt is a violation.
---

# AgentChat-Muse — Muse.ai LLM / agent worker (provider + subagent)

> **Last updated**: 2026-09-29
> **Job**: drive Muse.ai as a general **LLM / agent worker** (chat, research, secondary social ops) with a draft-only operator layer. Muse **IS** on OneWeb `PROVIDER_CHAIN` via `skills/lib/providers/adapters/muse.js` (near end — draft/unproven relative to peers). This skill is the operator / subagent layer on top.
> **Live posture**: draft-only. Adapter selectors are best-effort; live CDP chat prove is out of scope until Karl reopens social/browser work. `:8737` / Coolify stay off. No first GitHub release from this skill.

## Forced rule — invoke means execute

When this skill is invoked (`/AgentChat-Muse`, "muse signup", "muse worker", "resume Muse thread"), the **next** tool call MUST be one of:

```bash
node skills/AgentChat-Muse/index.js --ops-checklist
node skills/AgentChat-Muse/index.js --worker-plan
node skills/AgentChat-Muse/index.js --prompt-template
node skills/AgentChat-Muse/index.js --handoff
```

Skill-only install:

```bash
node ~/.agents/skills/AgentChat-Muse/index.js --ops-checklist
```

Smoke / doctor (no Muse browser automation):

```bash
node skills/AgentChat-Muse/index.js --smoke
node skills/AgentChat-Muse/index.js --doctor
```

Every real run prints one stderr receipt:

```
[receipt] AGENTCHAT_RUN {"run_id":"ac-…","skill":"AgentChat-Muse","exit":0,…}
```

Quote that line in the final answer. Missing receipt = did not execute.

## Provider + subagent (option C)

| Layer | What |
| --- | --- |
| **OneWeb provider** | `PROVIDER_CHAIN` key `muse` → `adapters/muse.js` auto-loaded into RUNNERS. agentweb-setup can classify/open `https://muse.ai/`. |
| **This skill** | Operator / worker modes: ops checklist, prompt templates, handoff receipts, worker plans. Does **not** launch live CDP signup tonight. |

Do **not** say "Muse is outside PROVIDER_CHAIN". It is on the chain (near end). Prefer stronger providers for production chat until live Muse prove lands.

## Hard posture (non-negotiable)

* **Draft-only.** Never auto-post, schedule, or run campaigns from this skill.
* **Never touch primary `@karldigi` X.** Secondary accounts only.
* **Stop on Karl stop.** No thrash loops, no "one more Continue" after STOP.
* **No live signup tonight unless Karl re-opens social work.** Default is checklist + handoff / worker text.
* **Secrets:** never paste JWTs, passwords, SMS codes, or pack JSON into SKILL.md / PR / chat. Reference local pack paths only (mode-600). Example pack root on box: `/workspace/archive/2026-09/social-secondary-2026-09-27/` (do not commit those files).

## Ops rules (hard-won)

1. **Ask Karl BEFORE triggering SMS.** OTP codes expire in minutes. Never burn an OTP while stuck on an anti-bot screen.
2. **Muse browser "Continue" often anti-bot.** Prefer desktop Chrome / operator handoff when Continue loops or CAPTCHA appears. Do not script around it blindly.
3. **TikTok web is often app-only / rate-limited.** Prefer App path after Muse create; document Muse-thread handoff for the human to finish in-app.
4. **LinkedIn stays parked** unless Karl explicitly reopens it.
5. **Repeat Muse chat short + clear** if Muse misses a step. One instruction per message; no novel-length prompts.
6. **Stop on Karl stop** — exit cleanly, leave thread URL + last state, do not retry.

## Browser endpoint preflight

For browser inspection, resolve the endpoint through AgentChat's shared config loader:

```bash
AGENTCHAT_CDP_URL=$(node -e 'process.stdout.write(require(process.env.HOME + "/.agents/skills/lib/cdp").CDP_URL)')
node ~/.agents/skills/AgentChat-OneWeb/index.js --doctor
playwright-cli attach --cdp="$AGENTCHAT_CDP_URL"
playwright-cli tab-list
```

The loader reports the selected `.env` path on stderr. Process environment overrides file values; `CDP_HOST` and `CDP_PORT` select the endpoint. Reuse the existing Muse thread and check for the visible `textarea[placeholder="Message"]` before declaring the session ready. Keep test messages within the user's explicit authorization.

On Box Fork-N desktops, `DISPLAY :N` maps to CDP port `9222+N`. Use this to diagnose a mismatch against the Chrome process and its open tabs. Pin the intended desktop in the local AgentChat `.env`; keep `AGENTCHAT_NO_AUTOSTART=1` for an existing operator-owned browser. The resolved endpoint also applies when using Playwright from another project directory.

## How to drive Muse as a general agent

Muse "does everything" as an agent worker — treat it like a capable chat LLM with tool/browse phases, not merely an ops checklist:

* **Chat / Q&A** — short clear prompts; one ask per turn; wait for completion before the next instruction.
* **Research** — ask Muse to browse/summarize; quote sources Muse returns; do not invent citations.
* **Secondary social ops** — only after Karl reopens social; use ops checklist + handoff; never auto-post.
* **OneWeb path** — when Chrome CDP is already up and Karl wants chain classify/open: Muse tab via provider key `muse`. Live send/extract prove is still draft until selectors are verified.

## Known Muse threads (example pointers only)

| Platform | Thread (public path) | Note |
| --- | --- | --- |
| X (secondary) | `https://muse.ai/thread/9c35d3a6-81fc-44ca-a199-046789429bdb` | Often pauses at phone Continue (anti-automation) |
| TikTok (secondary) | `https://muse.ai/thread/5d1e050f-b198-4143-8e77-d881cfe69403` | Pause before final creation; App path after |
| LinkedIn | parked | Do not resume unless Karl reopens |

## What this runner does / does not do

| Mode | Behavior |
| --- | --- |
| `--ops-checklist` (default) | Print ops rules + next-step handoff template; emit receipt |
| `--worker-plan` | Print how to use Muse as chat/research/social worker; emit receipt |
| `--prompt-template` | Print short Muse prompt templates (general agent); emit receipt |
| `--handoff` | Print operator handoff block for desktop Chrome / human; emit receipt |
| `--smoke` | Verify skill files + productMap + chain/adapter registration; no browser |
| `--doctor` | Same as smoke + warn if secret-looking pack paths are world-readable |
| Live Muse CDP drive / SMS / signup | **Out of scope tonight** — operator / desktop Chrome |

## Joining the skill set

* Directory: `skills/AgentChat-Muse/`
* Provider: `skills/lib/providers/chain.js` + `adapters/muse.js`
* Hub inventory: `skills/lib/providers/productMap.js` → `HUB_SKILLS` key `muse`
* Demo card: `demo/muse.html` + `demo/index.html`
* Install like other skills: symlink/copy `skills/AgentChat-Muse` into `~/.agents/skills/` (and keep sibling `skills/lib` available for `receipt.js`)

## Receipt contract

Final answer must include the stderr receipt line (at least `run_id`, `skill`, `exit`). Fabricating a run_id fails `grep` against `skills/AgentChat-Muse/data/receipts.jsonl`.
