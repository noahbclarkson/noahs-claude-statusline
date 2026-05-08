#!/usr/bin/env bash
# Stop hook: caches the current terminal width to ~/.claude/.statusline-cols
# so the statusline can use it on the next refresh. Re-runs after every
# agent response, which is how the statusline picks up terminal resizes.
#
# Why PowerShell? On Windows MSYS2 bash, hook subprocesses have no TTY:
# tput, stty, /dev/tty, $COLUMNS all fail. The Win32 Console API (queried
# via PowerShell) is the only path that works — and even then, naive
# $Host.UI.RawUI.WindowSize.Width returns a phantom 120 because PowerShell
# allocates its own default console. width-probe.ps1 walks the parent
# process tree, AttachConsole-s each ancestor, and reads the real terminal.

cat >/dev/null 2>&1   # drain Claude Code's JSON event payload off stdin

# Resolve the sibling probe script next to this hook, in Windows form for powershell.exe
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PS_SCRIPT_WIN=$(cygpath -w "$SCRIPT_DIR/width-probe.ps1" 2>/dev/null || echo "$SCRIPT_DIR/width-probe.ps1")

cols=$(powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
  -File "$PS_SCRIPT_WIN" 2>/dev/null | tr -d '\r\n ')

# Sanity check: must be a positive integer in a reasonable range
if [[ "$cols" =~ ^[0-9]+$ ]] && [ "$cols" -ge 40 ] && [ "$cols" -le 1000 ]; then
  printf '%s\n' "$cols" > "$HOME/.claude/.statusline-cols"
fi
