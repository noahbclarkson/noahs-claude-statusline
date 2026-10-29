#!/usr/bin/env bash

# Claude Code status line script (Linux variant). lib/render.sh draws the line;
# this file only finds the terminal's width.
#
# Width: detected directly by walking up /proc from this process to find the
# terminal's pseudo-terminal (pts) device and reading its winsize via
# `stty size`. The statusline subprocess has no controlling terminal of its
# own ($COLUMNS is empty, /dev/tty fails), but an ancestor process still holds
# an fd on the real pts, and the kernel stores the live window size there.
# Unlike the Windows path this is a few microseconds of /proc reads, so it runs
# inline every render — no Stop hook or PowerShell probe needed. Falls back to
# 120 if no pts ancestor is found.
#
# Ascend via field 4 (ppid) of /proc/PID/stat, checking fds 0/1/2/255 of each
# ancestor for a /dev/pts/* device. First hit wins.
find_cols() {
  local pid=$PPID depth=0 fd dev cols
  while [ -n "$pid" ] && [ "$pid" != "0" ] && [ "$pid" != "1" ] && [ "$depth" -lt 25 ]; do
    for fd in 0 1 2 255; do
      dev=$(readlink "/proc/$pid/fd/$fd" 2>/dev/null) || continue
      case "$dev" in
        /dev/pts/*)
          cols=$(stty size <"$dev" 2>/dev/null | awk '{print $2}')
          [[ "$cols" =~ ^[0-9]+$ ]] && { STATUSLINE_COLS=$cols; return; }
          ;;
      esac
    done
    pid=$(awk '{print $4}' "/proc/$pid/stat" 2>/dev/null)
    depth=$((depth + 1))
  done
}

here="${BASH_SOURCE[0]%/*}"
[ "$here" = "${BASH_SOURCE[0]}" ] && here=.
. "$here/lib/render.sh"
