# Feature flags (FF-01)

The registry in `skills/lib/features.js` describes flags that already ship.
**No adapter is rewired**: `chain.js`, `execute.js`, the provider adapters and
`isDeepResearchActive` read their env vars directly, exactly as before. This
layer adds metadata, a resolver, an invariant check and a doctor — nothing else.

`AGENTCHAT_DISABLED` is documented in `cdp.js` comments and skill docs but no
code reads it, so it is not registered. The doctor prints
`AGENTCHAT_DISABLED: documented, not read by code`.

## Stages

| Stage | Meaning |
|-------|---------|
| `experimental` | Shape may change; default-on requires an `EXCEPTIONS` entry. |
| `under-development` | Incomplete; must be default-off. |
| `stable` | Behavior operators rely on; default-on allowed. |
| `deprecated` | Still read, slated for removal. |
| `removed` | Inert: always the compiled default, ignoring both override maps. |

## Precedence

Compiled default < `.features.local.json` < process env.

- Local file keys may be the flag id (`deepResearch`) or the env key
  (`AGENTCHAT_DEEP_RESEARCH`), and must be JSON booleans.
- Env values: `1/true/yes/on` → true, `0/false/no/off` → false, case-insensitive
  and trimmed. Anything else throws an error naming the key; the offending
  value is never echoed, so the doctor cannot print an env value.
- `.features.local.json` lives at the repo root, is gitignored, and is read only
  by the doctor. Anchors: `FEATURE_FLAGS_LOCAL_FILE`, `readLocalFile`,
  `resolve`, `resolveWithSource`, `resolveSpec`, `resolveSpecWithSource`.

## The invariant

`checkInvariant({ flags, exceptions, providerKeys })` returns human-readable
violations (empty array = ok):

1. A default-on flag whose stage is not `stable`/`removed` and has no
   `EXCEPTIONS` entry.
2. An `EXCEPTIONS` entry with an empty or missing note.
3. An `EXCEPTIONS` entry naming an unknown flag id.
4. Duplicate id.
5. Duplicate key.
6. Provider entries out of sync with `PROVIDER_KEYS` in either direction.

## Promotion diff

A default-off `experimental` flag becomes default-on with a two-line change in
`skills/lib/features.js`:

```diff
-        stage: 'experimental',
-        defaultEnabled: false,
+        stage: 'stable',
+        defaultEnabled: true,
```

`EXCEPTIONS` is empty since 2026-10-29: `providerMuse` was promoted to
stage `stable` (default-on) by Karl decision 2026-10-29 (MUSE-PROMOTE); the
adapter is actively used in PROVIDER_CHAIN.

## Doctor

```bash
npm run doctor:features        # or: node skills/lib/features-doctor.js
```

Prints a header, one `id | key | stage | default | effective | source` row per
flag in registry order, then the `AGENTCHAT_DISABLED` line, then
`invariant: ok` or `invariant: FAILED (n)`. Violation detail goes to stderr.

Exit codes: `0` when ok; `1` on any invariant violation or resolve error.
No network, no CDP, no Chrome.

Test-only hook: `AGENTCHAT_FEATURES_REGISTRY_MODULE=<path>` points the doctor at
a module exporting `FEATURE_FLAGS`/`EXCEPTIONS`, so the failure path can be
exercised without editing the real registry. Absent, the doctor uses
`./features`.

## Test legs

```bash
npm run test:flags             # or: node scripts/test-flags.js
```

Each leg pins one env var and re-runs the suites that read it, printing
`PASS`/`FAIL`/`SKIP` per suite plus `<n> legs, <n> failed, <n> skipped`:

| Env | Suites |
|-----|--------|
| `AGENTCHAT_DEEP_RESEARCH=1` | `test_features.js`, `test_execute_dr_timeout.js`, `test_chatgpt_composer_toggles.js` |
| `AGENTCHAT_DEEP_RESEARCH=0` | same three |
| `AGENTCHAT_KIMI_NO_THINK=1` | `test_features.js`, `test_kimi_modes.js`, `test_chatgpt_composer_toggles.js` |
| `AGENTCHAT_KIMI_NO_THINK=0` | same three |

## Out of scope: parameters, not flags

These env vars carry a value; they are parameters and stay out of the registry:
`AGENTCHAT_KIMI_MODE`, `AGENTCHAT_CLAUDE_EFFORT`, `AGENTCHAT_GEMINI_MODEL`,
`AGENTCHAT_GEMINI_COMPOSER_MODE`, `AGENTCHAT_MUSE_URL`, paths
(`AGENTCHAT_ASSETS_DIR`, `AGENTCHAT_HOME`, `AGENTCHAT_ENV_FILE`), ports
(`CDP_PORT`, `CDP_HOST`) and the `AGENTCHAT_MAX_*` caps.

Design notes: `wiki projects/infrastructure/architecture/2026-10-28-dd-feature-flag-dev-cycle.md`.
