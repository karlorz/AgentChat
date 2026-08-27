# Changelog
## 2026-08-27 (v1.1)
- Claude `org_disabled` even when a composer/editor is visible (banner HTML or chat-org `api_disabled_reason`; send is a no-op)
- ChatGLM sidebar 未登录 / 登录 (`sidebar-user-name` + guest-avatar) is `logged_out`; composer presence is not enough
- `no_tab` opens a new tab on the official PROVIDER_CHAIN URL in the existing Chrome (CDP attach to 127.0.0.1:9227)
- Never `browser.close()` the shared profile5 CDP — detach only; Chrome stays up
- Fixtures + tests for the Claude / ChatGLM live misses; Doubao region-ban tests kept

## 2026-08-27 (v1)
- New command agentweb-setup
- Attach to existing Chrome CDP only
- Dry-detect mode
- Page-state classifier and Doubao region-ban fixtures
