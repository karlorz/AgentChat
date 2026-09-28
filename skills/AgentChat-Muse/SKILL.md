---
name: AgentChat-Muse
description: Draft-only Muse.ai operator skill for secondary social signup/ops (X / TikTok; LinkedIn parked). Use for Muse thread handoff, OTP discipline, anti-bot Continue stalls, and App-path TikTok. Never auto-post, never touch primary @karldigi X, never invent first GitHub release. MANDATORY EXECUTION — invoking this skill REQUIRES running `node skills/AgentChat-Muse/index.js` (or `~/.agents/skills/AgentChat-Muse/index.js`) as the FIRST action and quoting its `[receipt] AGENTCHAT_RUN` line; narrating without a receipt is a violation.
---

# AgentChat-Muse — Muse.ai secondary social ops (draft-only)

> **Last updated**: 2026-09-29
> **Job**: teach agents how to drive Muse.ai for **secondary** social account create/resume — **draft / operator-handoff only**. No live campaign posts. No Coolify. `:8737` stays off until Karl says start.
> **Not a chat LLM provider**: Muse is outside the OneWeb CDP provider chain. Do not add Muse to `PROVIDER_CHAIN`.

## Forced rule — invoke means execute

When this skill is invoked (`/AgentChat-Muse`, "muse signup", "resume Muse thread"), the **next** tool call MUST be:

```bash
node skills/AgentChat-Muse/index.js --ops-checklist
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

## Hard posture (non-negotiable)

* **Draft-only.** Never auto-post, schedule, or run campaigns from this skill.
* **Never touch primary `@karldigi` X.** Secondary accounts only.
* **Stop on Karl stop.** No thrash loops, no "one more Continue" after STOP.
* **No live signup tonight unless Karl re-opens social work.** Default is checklist + handoff text.
* **Secrets:** never paste JWTs, passwords, SMS codes, or pack JSON into SKILL.md / PR / chat. Reference local pack paths only (mode-600). Example pack root on box: `/workspace/archive/2026-09/social-secondary-2026-09-27/` (do not commit those files).

## Ops rules (hard-won)

1. **Ask Karl BEFORE triggering SMS.** OTP codes expire in minutes. Never burn an OTP while stuck on an anti-bot screen.
2. **Muse browser "Continue" often anti-bot.** Prefer desktop Chrome / operator handoff when Continue loops or CAPTCHA appears. Do not script around it blindly.
3. **TikTok web is often app-only / rate-limited.** Prefer App path after Muse create; document Muse-thread handoff for the human to finish in-app.
4. **LinkedIn stays parked** unless Karl explicitly reopens it.
5. **Repeat Muse chat short + clear** if Muse misses a step. One instruction per message; no novel-length prompts.
6. **Stop on Karl stop** — exit cleanly, leave thread URL + last state, do not retry.

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
| `--smoke` | Verify skill files + productMap registration; no browser |
| `--doctor` | Same as smoke + warn if secret-looking pack paths are world-readable |
| Live Muse CDP drive | **Out of scope for v1** — operator / desktop Chrome |

## Joining the skill set

* Directory: `skills/AgentChat-Muse/`
* Hub inventory: `skills/lib/providers/productMap.js` → `HUB_SKILLS` key `muse`
* Demo card: `demo/muse.html` + `demo/index.html`
* Install like other skills: symlink/copy `skills/AgentChat-Muse` into `~/.agents/skills/` (and keep sibling `skills/lib` available for `receipt.js`)

## Receipt contract

Final answer must include the stderr receipt line (at least `run_id`, `skill`, `exit`). Fabricating a run_id fails `grep` against `skills/AgentChat-Muse/data/receipts.jsonl`.
