#!/usr/bin/env bash

# Claude Code status line script (Linux variant)
# Layout: model | parent/dir | branch[*↑↓] | rate-limits | context% [bar]
#
# Width: detected directly by walking up /proc from this process to find the
# terminal's pseudo-terminal (pts) device and reading its winsize via
# `stty size`. The statusline subprocess has no controlling terminal of its
# own ($COLUMNS is empty, /dev/tty fails), but an ancestor process still holds
# an fd on the real pts, and the kernel stores the live window size there.
# Unlike the Windows path this is a few microseconds of /proc reads, so it runs
# inline every render — no Stop hook or PowerShell probe needed. Falls back to
# 120 if no pts ancestor is found.
STATUSLINE_COLS=120

input=$(cat)

# --- ANSI color helpers ---
# Real ESC bytes rather than "\033" strings, so the final printf can use %s
# instead of %b. %b would also expand backslash escapes in the *data* — a
# branch or directory name containing \t renders as a tab and silently breaks
# the visible-length math the layout depends on.
RESET=$'\033[0m'
BOLD=$'\033[1m'
DIM=$'\033[2m'
FG_WHITE=$'\033[97m'
FG_YELLOW=$'\033[93m'
FG_DARK_ORANGE=$'\033[38;5;172m'

# Truncate a string to max visible chars, appending … if cut.
# Bash substring expansion is character-based under a UTF-8 locale.
truncate_str() {
  local s="$1" max="$2"
  if [ "${#s}" -le "$max" ]; then
    printf '%s' "$s"
  else
    printf '%s…' "${s:0:$((max-1))}"
  fi
}

# Smooth green→yellow→orange→red gradient for a 0-100 value. Writes a 24-bit
# truecolor SGR sequence to $grad_result via printf -v, so there's no subshell
# fork (costly on Windows) per call. Piecewise-linear RGB interpolation across
# the anchor stops below; they keep the lower range green and ramp to red only
# near the top, echoing the old discrete thresholds but continuously.
grad_result=""
grad_color() {
  local p=$1
  [ "$p" -lt 0 ] && p=0
  [ "$p" -gt 100 ] && p=100
  # anchor stops: pct R G B
  local stops=(0 80 200 100  55 222 205 35  80 255 140 20  100 228 55 45)
  local i p0 r0 g0 b0 p1 r1 g1 b1 span t
  for ((i=0; i+7 < ${#stops[@]}; i+=4)); do
    p1=${stops[i+4]}
    [ "$p" -gt "$p1" ] && continue
    p0=${stops[i]};   r0=${stops[i+1]}; g0=${stops[i+2]}; b0=${stops[i+3]}
    r1=${stops[i+5]}; g1=${stops[i+6]}; b1=${stops[i+7]}
    span=$((p1 - p0)); t=$((p - p0))
    [ "$span" -le 0 ] && span=1
    printf -v grad_result '\033[38;2;%d;%d;%dm' \
      "$(( r0 + (r1 - r0) * t / span ))" \
      "$(( g0 + (g1 - g0) * t / span ))" \
      "$(( b0 + (b1 - b0) * t / span ))"
    return
  done
}

# Render $1 with a per-character gradient between two RGB endpoints ($2-$4
# start, $5-$7 end), written to $grad_text. The emitted SGR codes are
# zero-width, so this does not change the visible-length math downstream.
grad_text=""
gradient_text() {
  local text="$1" r0=$2 g0=$3 b0=$4 r1=$5 g1=$6 b1=$7
  local n=${#text} denom i ch r g b out=""
  denom=$(( n > 1 ? n - 1 : 1 ))
  for ((i=0; i<n; i++)); do
    ch=${text:i:1}
    r=$(( r0 + (r1 - r0) * i / denom ))
    g=$(( g0 + (g1 - g0) * i / denom ))
    b=$(( b0 + (b1 - b0) * i / denom ))
    out+=$'\033'"[38;2;${r};${g};${b}m${ch}"
  done
  grad_text="$out"
}

# --- Parse all stdin JSON fields in a single jq call (perf: fork is expensive on Windows) ---
eval "$(printf '%s' "$input" | jq -r '
  @sh "model_id=\(.model.id // "")",
  @sh "model_display=\(.model.display_name // "Claude")",
  @sh "project_dir=\(.workspace.project_dir // .cwd // "")",
  @sh "session_id=\(.session_id // "")",
  @sh "used_pct=\(.context_window.used_percentage // 0)",
  @sh "five_pct_raw=\(.rate_limits.five_hour.used_percentage // "")",
  @sh "week_pct_raw=\(.rate_limits.seven_day.used_percentage // "")"
' 2>/dev/null)"

# --- Terminal width: walk up /proc to the terminal's pts and read its winsize ---
# This subprocess has no controlling terminal, but an ancestor (the shell /
# terminal emulator) still holds an fd on the real pts, whose live window size
# the kernel exposes via `stty size`. Ascend via field 4 (ppid) of /proc/PID/stat,
# checking fds 0/1/2/255 of each ancestor for a /dev/pts/* device. First hit wins.
detect_cols() {
  local pid=$PPID depth=0 fd dev cols
  while [ -n "$pid" ] && [ "$pid" != "0" ] && [ "$pid" != "1" ] && [ "$depth" -lt 25 ]; do
    for fd in 0 1 2 255; do
      dev=$(readlink "/proc/$pid/fd/$fd" 2>/dev/null) || continue
      case "$dev" in
        /dev/pts/*)
          cols=$(stty size <"$dev" 2>/dev/null | awk '{print $2}')
          [[ "$cols" =~ ^[0-9]+$ ]] && { printf '%s' "$cols"; return; }
          ;;
      esac
    done
    pid=$(awk '{print $4}' "/proc/$pid/stat" 2>/dev/null)
    depth=$((depth + 1))
  done
}
detected_cols=$(detect_cols)
[[ "$detected_cols" =~ ^[0-9]+$ ]] && STATUSLINE_COLS="$detected_cols"

# --- Shorten verbose model display names ---
model_display="${model_display/ (1M context)/ (1M)}"

# --- Model name: per-family endpoints for a left-to-right gradient ---
case "$model_id" in
  *opus*)   model_rgb=(255 95 215  115 100 255) ;;  # magenta → violet-blue
  *sonnet*) model_rgb=(70 230 235  105 120 255) ;;  # cyan → indigo
  *haiku*)  model_rgb=(175 240 90   55 205 185) ;;  # lime → teal
  *)        model_rgb=(70 230 235  105 120 255) ;;
esac

# --- Project dir: parent/current ---
if [ -n "$project_dir" ]; then
  dir_current=$(basename "$project_dir")
  dir_parent=$(basename "$(dirname "$project_dir")")
  dir_display="$dir_parent/$dir_current"
else
  dir_display="unknown"
fi

# --- Git branch + dirty indicator + ahead/behind ---
# Fast-path: walk up the tree (fork-free) looking for .git before spawning git.
branch=""
git_suffix=""
in_git_repo=""
if [ -n "$project_dir" ]; then
  check_dir="$project_dir"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -z "$check_dir" ] && break
    [ "$check_dir" = "/" ] && break
    if [ -e "$check_dir/.git" ]; then
      in_git_repo=1
      break
    fi
    parent="${check_dir%/*}"
    [ "$parent" = "$check_dir" ] && break
    check_dir="$parent"
  done
fi
git_dirty=""
git_ab=""
git_ab_cells=0   # visible-cell count of git_ab (arrows are 1 cell but 3 bytes in UTF-8)
if [ -n "$in_git_repo" ] && command -v git >/dev/null 2>&1; then
  branch=$(git -C "$project_dir" --no-optional-locks branch --show-current 2>/dev/null)
  # Detached HEAD (bisect, a checked-out tag, a rebase in flight) has no branch
  # name; the short SHA keeps the segment useful instead of blanking it.
  if [ -z "$branch" ]; then
    branch=$(git -C "$project_dir" --no-optional-locks rev-parse --short HEAD 2>/dev/null)
  fi
  if [ -n "$branch" ]; then
    if [ -n "$(git -C "$project_dir" --no-optional-locks status --porcelain 2>/dev/null)" ]; then
      git_dirty="*"
    fi
    ab=$(git -C "$project_dir" --no-optional-locks rev-list --left-right --count "@{upstream}...HEAD" 2>/dev/null)
    if [ -n "$ab" ]; then
      behind=$(echo "$ab" | awk '{print $1}')
      ahead=$(echo "$ab"  | awk '{print $2}')
      if [ "$ahead"  -gt 0 ] 2>/dev/null; then
        git_ab+="↑${ahead}"
        git_ab_cells=$((git_ab_cells + 1 + ${#ahead}))
      fi
      if [ "$behind" -gt 0 ] 2>/dev/null; then
        git_ab+="↓${behind}"
        git_ab_cells=$((git_ab_cells + 1 + ${#behind}))
      fi
    fi
  fi
fi
git_suffix="${git_dirty}${git_ab}"

# --- Context usage ---
used_int=$(printf '%.0f' "$used_pct" 2>/dev/null || echo 0)
# A host reporting over 100% would make filled_eighths exceed the bar's own
# width further down, pushing the rendered bar past $cols and wrapping the line.
[ "$used_int" -lt 0 ] 2>/dev/null && used_int=0
[ "$used_int" -gt 100 ] 2>/dev/null && used_int=100

grad_color "$used_int"
bar_fill_color="$grad_result"
bar_empty_color=$'[90m'
bar_empty_bg=$'[48;5;236m'  # dark gray BG used behind the partial-block boundary cell

# --- Rate limits ---
rate_str=""
plain_rate=""
# A non-numeric percentage fails the conversion and drops its segment, rather
# than feeding garbage into grad_color's arithmetic or reporting a bare 0%.
if [ -n "$five_pct_raw" ] && five_int=$(printf '%.0f' "$five_pct_raw" 2>/dev/null); then
  grad_color "$five_int"
  five_color="$grad_result"
  rate_str+="${five_color}5h:${five_int}%${RESET}"
  plain_rate+="5h:${five_int}%"
fi
if [ -n "$week_pct_raw" ] && week_int=$(printf '%.0f' "$week_pct_raw" 2>/dev/null); then
  grad_color "$week_int"
  week_color="$grad_result"
  [ -n "$rate_str" ] && rate_str+=" "
  [ -n "$plain_rate" ] && plain_rate+=" "
  rate_str+="${week_color}7d:${week_int}%${RESET}"
  plain_rate+="7d:${week_int}%"
fi

# --- Decide which segments to keep so prefix + bar fit within $cols ---
# Degradation order (least essential dropped first):
#   1. rate-limits segment
#   2. git ahead/behind suffix (keep dirty *)
#   3. parent directory
#   4. truncate branch to 14, then 8
#   5. truncate current dir to 18, then 10
#   6. drop the bar entirely
cols=$STATUSLINE_COLS
TARGET_BAR=8           # min bar interior cells we want
SEP_LEN=3              # " │ " visible width

# Compute prefix visible length (in cells) for a given configuration.
# All non-separator strings are assumed ASCII; truncation clamps to b_max/d_max
# cells (truncate_str produces exactly that many visible cells via …). The
# only multi-byte fields handled specially are the SEP_LEN constant and
# git_ab_cells, both pre-computed in cells rather than bytes.
# args: include_rate include_ab include_parent branch_max dir_max
prefix_visible_len() {
  local inc_rate=$1 inc_ab=$2 inc_par=$3 b_max=$4 d_max=$5
  local n=${#model_display}
  n=$((n + SEP_LEN))
  if [ "$inc_par" = 1 ] && [ -n "$dir_parent" ]; then
    n=$((n + ${#dir_parent} + 1))   # parent + "/"
  fi
  local d_eff_len=${#dir_current}
  [ -z "$dir_current" ] && d_eff_len=7   # "unknown"
  [ "$d_eff_len" -gt "$d_max" ] && d_eff_len=$d_max
  n=$((n + d_eff_len))
  if [ -n "$branch" ]; then
    n=$((n + SEP_LEN))
    local b_eff_len=${#branch}
    [ "$b_eff_len" -gt "$b_max" ] && b_eff_len=$b_max
    n=$((n + b_eff_len))
    n=$((n + ${#git_dirty}))
    [ "$inc_ab" = 1 ] && n=$((n + git_ab_cells))
  fi
  if [ "$inc_rate" = 1 ] && [ -n "$plain_rate" ]; then
    n=$((n + SEP_LEN + ${#plain_rate}))
  fi
  n=$((n + SEP_LEN + ${#used_int} + 2))   # " │ N% "
  echo "$n"
}

inc_rate=1; inc_ab=1; inc_par=1
b_max=999; d_max=999
drop_bar=0
budget=$((cols - 2 - TARGET_BAR))   # 2 for brackets

while :; do
  len=$(prefix_visible_len "$inc_rate" "$inc_ab" "$inc_par" "$b_max" "$d_max")
  [ "$len" -le "$budget" ] && break

  if [ "$inc_rate" = 1 ] && [ -n "$plain_rate" ]; then
    inc_rate=0
  elif [ "$inc_ab" = 1 ] && [ -n "$git_ab" ]; then
    inc_ab=0
  elif [ "$inc_par" = 1 ] && [ -n "$dir_parent" ]; then
    inc_par=0
  elif [ "$b_max" -gt 14 ] && [ -n "$branch" ] && [ "${#branch}" -gt 14 ]; then
    b_max=14
  elif [ "$d_max" -gt 18 ] && [ "${#dir_current}" -gt 18 ]; then
    d_max=18
  elif [ "$b_max" -gt 8 ] && [ -n "$branch" ] && [ "${#branch}" -gt 8 ]; then
    b_max=8
  elif [ "$d_max" -gt 10 ] && [ "${#dir_current}" -gt 10 ]; then
    d_max=10
  else
    drop_bar=1
    break
  fi
done

# --- Build the colored prefix from chosen segments ---
sep="${DIM}│${RESET}"

gradient_text "$model_display" "${model_rgb[@]}"
colored_prefix="${BOLD}${grad_text}${RESET}"
colored_prefix+=" ${sep} "
if [ "$inc_par" = 1 ] && [ -n "$dir_parent" ]; then
  colored_prefix+="${FG_DARK_ORANGE}${dir_parent}${RESET}${DIM}/${RESET}"
fi
dir_show=$(truncate_str "${dir_current:-unknown}" "$d_max")
colored_prefix+="${BOLD}${FG_YELLOW}${dir_show}${RESET}"

if [ -n "$branch" ]; then
  colored_prefix+=" ${sep} "
  branch_show=$(truncate_str "$branch" "$b_max")
  gradient_text "$branch_show" 175 90 245  70 140 255
  colored_prefix+="${grad_text}${RESET}"
  [ -n "$git_dirty" ] && colored_prefix+="${DIM}${git_dirty}${RESET}"
  if [ "$inc_ab" = 1 ] && [ -n "$git_ab" ]; then
    colored_prefix+="${DIM}${git_ab}${RESET}"
  fi
fi

if [ "$inc_rate" = 1 ] && [ -n "$rate_str" ]; then
  colored_prefix+=" ${sep} "
  colored_prefix+="${rate_str}"
fi

colored_prefix+=" ${sep} "
colored_prefix+="${FG_WHITE}${used_int}%${RESET}"
colored_prefix+=" "

# Visible length in cells — matches what we used during the budget loop, so
# bar sizing stays consistent (avoids the byte-vs-cell discrepancy that
# stripping ANSI + ${#stripped} would introduce for │ separators and arrows).
visible_len=$(prefix_visible_len "$inc_rate" "$inc_ab" "$inc_par" "$b_max" "$d_max")

# --- Calculate bar width ---
# Take 95% of the free space and trim 2 more cells, keeping a clear right-edge
# margin; cap the interior at MAX_BAR_LEN on wide terminals. Clamp into
# [1, free space]: subtracting from the free space keeps the bar narrower than
# the room available (so it can never wrap off the right edge), and the floor
# stops it ever being empty or negative. With no room at all, drop the bar.
MAX_BAR_LEN=70
bar_outer=2  # brackets [ ]
available=$((cols - visible_len - bar_outer))
if [ "$available" -lt 1 ]; then
  drop_bar=1
  available=1
else
  available=$(( available * 95 / 100 - 2 ))
  [ "$available" -gt "$MAX_BAR_LEN" ] && available=$MAX_BAR_LEN
  [ "$available" -lt 1 ] && available=1
fi

# Sub-cell precision: each cell = 8 eighths, so the boundary cell
# can render a fractional block for smoother growth.
total_eighths=$(( available * 8 ))
filled_eighths=$(( total_eighths * used_int / 100 ))
full_cells=$(( filled_eighths / 8 ))
remainder=$(( filled_eighths % 8 ))
empty=$(( available - full_cells - (remainder > 0 ? 1 : 0) ))
[ "$empty" -lt 0 ] && empty=0

partial_char=""
case "$remainder" in
  1) partial_char="▏" ;;
  2) partial_char="▎" ;;
  3) partial_char="▍" ;;
  4) partial_char="▌" ;;
  5) partial_char="▋" ;;
  6) partial_char="▊" ;;
  7) partial_char="▉" ;;
esac

bar_filled=""
bar_empty_str=""
for ((i=0; i<full_cells; i++)); do
  bar_filled+="█"
done
for ((i=0; i<empty; i++)); do
  bar_empty_str+="░"
done

# Boundary cell: the partial-block glyphs (▏▎▍▌▋▊▉) only paint the LEFT
# fraction of their cell — without a BG, the right portion shows the
# terminal default and reads as a gap before the empty fill begins.
partial_segment=""
if [ -n "$partial_char" ]; then
  partial_segment="${bar_fill_color}${bar_empty_bg}${partial_char}${RESET}"
fi

if [ "$drop_bar" = 1 ]; then
  bar=""
else
  bar="${DIM}[${RESET}${bar_fill_color}${bar_filled}${RESET}${partial_segment}${bar_empty_color}${bar_empty_str}${RESET}${DIM}]${RESET}"
fi

printf '%s%s\n' "$colored_prefix" "$bar"
