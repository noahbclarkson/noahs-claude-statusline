#!/usr/bin/env bash

# Claude Code status line script (Windows: Git Bash / MSYS2). lib/render.sh
# draws the line; this file only finds the terminal's width.
#
# Width: read from a per-session cache file written by the Stop hook
# (width-hook.sh), which runs PowerShell to query the real terminal width via
# the Win32 Console API. The cache is keyed by session_id (parsed from the
# payload before find_cols runs) so concurrent Claude Code instances in
# differently-sized terminals never clobber one another's width through a
# single shared file. Falls back to 120 until this session's first Stop hook
# fires.
#
# Sanitize the id to filename-safe chars. With no usable id, keep the 120
# default rather than reading any shared file — a shared read is exactly the
# cross-instance clobbering this per-session keying exists to prevent.
find_cols() {
  local session_key="${session_id//[^A-Za-z0-9_-]/}" cached_cols
  if [ -n "$session_key" ] && [ -r "$HOME/.claude/.statusline-cols-$session_key" ]; then
    cached_cols=$(< "$HOME/.claude/.statusline-cols-$session_key")
    [[ "$cached_cols" =~ ^[0-9]+$ ]] && STATUSLINE_COLS="$cached_cols"
  fi
}

here="${BASH_SOURCE[0]%/*}"
[ "$here" = "${BASH_SOURCE[0]}" ] && here=.
. "$here/lib/render.sh"
