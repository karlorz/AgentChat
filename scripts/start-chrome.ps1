# ============================================================
# AgentChat — Chrome CDP 启动器 (Windows PowerShell) — compatibility edge
#
# 用法:
#   .\scripts\start-chrome.ps1                  # 启动 (默认: 可见窗口)
#   .\scripts\start-chrome.ps1 -FirstLogin      # 打开 Gemini 登录页并等待登录
#   .\scripts\start-chrome.ps1 -Headless        # headless 模式 (profile 必须已登录)
#   .\scripts\start-chrome.ps1 -Stop            # 停止本脚本管理的 Chrome
#
# 该脚本不再拥有独立的生命周期实现：.env 由共享 Node 引擎安全加载
# (scripts/lib/chrome-debug-lifecycle.cjs，永不 `source`)，所有进程管理、
# ownership 状态、daemon 监督和 stop/restart 逻辑都位于该引擎，
# 经 scripts\run-helper.cmd chrome-debug 桥接调用。
# 这里只做旧参数映射与转发。
#
# 环境变量 (.env 文件由引擎加载):
#   CDP_PORT / CHROME_PROFILE / CHROMIUM_PATH / PROXY_SERVER / GEMINI_URL / HEADLESS
# ============================================================

param(
    [switch]$FirstLogin,
    [switch]$Headless,
    [switch]$Stop
)

$ErrorActionPreference = "Stop"

# ── 兼容默认值（保留旧脚本行为；引擎内 CHROME_PROFILE 优先于 CHROME_DEBUG_PROFILE）──
if (-not $env:CHROME_PROFILE -and -not $env:CHROME_DEBUG_PROFILE) {
    $env:CHROME_PROFILE = "$env:USERPROFILE\.chrome-debug-profile"
}

# ── 旧参数 → 共享命令表面 ────────────────────────────────────────────────
$EngineArgs = @()
if ($Stop)      { $EngineArgs += "--stop" }
if ($Headless)  { $EngineArgs += "--headless" }
if ($FirstLogin) { $EngineArgs += "--first-login" }

$HelperDir = Split-Path -Parent $PSCommandPath
$Bridge = Join-Path $HelperDir "run-helper.cmd"
$CmdLine = "`"$Bridge`" chrome-debug"
if ($EngineArgs.Count -gt 0) {
    $CmdLine += " " + (($EngineArgs | ForEach-Object { "`"$_`"" }) -join " ")
}

# 转发参数（含后续位置参数，如 URL）
foreach ($a in $args) { $CmdLine += " `"$a`"" }

& cmd.exe /d /c $CmdLine
exit $LASTEXITCODE
