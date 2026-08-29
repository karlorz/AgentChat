# Changelog
## 2026-08-27 (v1.1)
- Claude `org_disabled` even when a composer is visible and there is NO toast — send-probe and/or `/api/organizations` account check required; visible editor is not ready
- ChatGLM sidebar 未登录 / 登录 (`sidebar-user-name` + guest-avatar) is `logged_out`; Access Verification slide captcha is also `logged_out`; composer presence is not enough
- Qwen / Kimi guest composer + 登录 / Log in is `logged_out` (guest composer is not ready)
- DeepSeek `/sign_in`, MiniMax, MiMo login walls are `logged_out`
- `no_tab` opens a new tab on the official PROVIDER_CHAIN URL via `context.newPage()` in the existing Chrome (CDP attach to 127.0.0.1:9227)
- Never close the shared profile5 CDP — `detachBrowser` disconnects only; Chrome stays up
- Fixtures + tests for Claude silent no-op, ChatGLM sidebar/captcha, Qwen/Kimi guest+login; Doubao region-ban kept

## 2026-08-27 (v1)
- New command agentweb-setup
- Attach to existing Chrome CDP only
- Dry-detect mode
- Page-state classifier and Doubao region-ban fixtures
