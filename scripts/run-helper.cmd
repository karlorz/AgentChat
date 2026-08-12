: << 'CMDBLOCK'
@echo off
REM ============================================================
REM run-helper.cmd — cross-platform helper dispatcher (AgentChat)
REM
REM Polyglot: cmd.exe runs the batch portion; Bash (POSIX/Git Bash)
REM interprets the same file as a shell script whose body starts after
REM the CMDBLOCK heredoc.
REM
REM Windows: resolves Git-for-Windows Bash from standard locations,
REM then PATH, and runs the named extensionless helper. Fails loudly
REM (non-zero) when Bash is missing: launching Chrome is a required
REM operation, not an optional hook.
REM
REM POSIX: runs the named helper directly with bash.
REM
REM Usage: run-helper.cmd <helper-name> [args...]
REM ============================================================

if "%~1"=="" (
    echo run-helper.cmd: missing helper name >&2
    exit /b 1
)

set "HELPER_DIR=%~dp0"
set "HELPER_NAME=%~1"

REM Try Git for Windows bash in standard locations.
if exist "C:\Program Files\Git\bin\bash.exe" (
    call "C:\Program Files\Git\bin\bash.exe" "%HELPER_DIR%%HELPER_NAME%" %*
    exit /b %ERRORLEVEL%
)
if exist "C:\Program Files (x86)\Git\bin\bash.exe" (
    call "C:\Program Files (x86)\Git\bin\bash.exe" "%HELPER_DIR%%HELPER_NAME%" %*
    exit /b %ERRORLEVEL%
)
if exist "%LOCALAPPDATA%\Programs\Git\bin\bash.exe" (
    call "%LOCALAPPDATA%\Programs\Git\bin\bash.exe" "%HELPER_DIR%%HELPER_NAME%" %*
    exit /b %ERRORLEVEL%
)

REM Try bash on PATH (user-installed Git Bash, MSYS2, Cygwin).
where bash >nul 2>nul
if %ERRORLEVEL% equ 0 (
    call bash "%HELPER_DIR%%HELPER_NAME%" %*
    exit /b %ERRORLEVEL%
)

echo run-helper.cmd: Git Bash not found >&2
echo Install Git for Windows (https://gitforwindows.org/) to use AgentChat Chrome lifecycle commands. >&2
exit /b 1
CMDBLOCK

# POSIX branch: run the named helper directly.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HELPER_NAME="$1"
if [ -z "$HELPER_NAME" ]; then
    echo "run-helper.cmd: missing helper name" >&2
    exit 1
fi
shift
exec bash "${SCRIPT_DIR}/${HELPER_NAME}" "$@"
