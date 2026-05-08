#!/usr/bin/env bash

# Claude Code status line script
# Layout: model | parent/dir | branch[*↑↓] | rate-limits | context% [bar]
#
# Width: read from a cache file written by the Stop hook (width-hook.sh),
# which runs PowerShell to query the real terminal width via the Win32
# Console API. Falls back to 120 if the cache is missing — happens before
# the first Stop hook fires in a new session.
STATUSLINE_COLS=120
if [ -r "$HOME/.claude/.statusline-cols" ]; then
  cached_cols=$(< "$HOME/.claude/.statusline-cols")
  [[ "$cached_cols" =~ ^[0-9]+$ ]] && STATUSLINE_COLS="$cached_cols"
fi

input=$(cat)

# --- ANSI color helpers ---
RESET="\033[0m"
BOLD="\033[1m"
DIM="\033[2m"
FG_WHITE="\033[97m"
FG_CYAN="\033[96m"
FG_YELLOW="\033[93m"
FG_MAGENTA="\033[95m"
FG_GREEN="\033[92m"
FG_RED="\033[91m"
FG_ORANGE="\033[38;5;208m"
FG_DARK_ORANGE="\033[38;5;172m"

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

# --- Parse all stdin JSON fields in a single jq call (perf: fork is expensive on Windows) ---
eval "$(printf '%s' "$input" | jq -r '
  @sh "model_id=\(.model.id // "")",
  @sh "model_display=\(.model.display_name // "Claude")",
  @sh "project_dir=\(.workspace.project_dir // .cwd // "")",
  @sh "used_pct=\(.context_window.used_percentage // 0)",
  @sh "five_pct_raw=\(.rate_limits.five_hour.used_percentage // "")",
  @sh "week_pct_raw=\(.rate_limits.seven_day.used_percentage // "")"
' 2>/dev/null)"

# --- Shorten verbose model display names ---
model_display="${model_display/ (1M context)/ (1M)}"

# --- Model with color coding by id ---
case "$model_id" in
  *opus*)   model_color="$FG_MAGENTA" ;;
  *sonnet*) model_color="$FG_CYAN"    ;;
  *haiku*)  model_color="$FG_GREEN"   ;;
  *)        model_color="$FG_CYAN"    ;;
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
if [ -n "$in_git_repo" ]; then
  branch=$(git -C "$project_dir" --no-optional-locks branch --show-current 2>/dev/null)
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

if [ "$used_int" -lt 50 ]; then
  bar_fill_color="\033[92m"        # green
elif [ "$used_int" -lt 75 ]; then
  bar_fill_color="\033[93m"        # yellow
elif [ "$used_int" -lt 90 ]; then
  bar_fill_color="\033[38;5;208m"  # orange
else
  bar_fill_color="\033[91m"        # red
fi
bar_empty_color="\033[90m"
bar_empty_bg="\033[48;5;236m"  # dark gray BG used behind the partial-block boundary cell

# --- Rate limits ---
rate_str=""
plain_rate=""
if [ -n "$five_pct_raw" ]; then
  five_int=$(printf '%.0f' "$five_pct_raw")
  if [ "$five_int" -lt 50 ]; then
    five_color="$FG_GREEN"
  elif [ "$five_int" -le 80 ]; then
    five_color="$FG_YELLOW"
  else
    five_color="$FG_RED"
  fi
  rate_str+="${five_color}5h:${five_int}%${RESET}"
  plain_rate+="5h:${five_int}%"
fi
if [ -n "$week_pct_raw" ]; then
  week_int=$(printf '%.0f' "$week_pct_raw")
  if [ "$week_int" -lt 50 ]; then
    week_color="$FG_GREEN"
  elif [ "$week_int" -le 80 ]; then
    week_color="$FG_YELLOW"
  else
    week_color="$FG_RED"
  fi
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

colored_prefix="${BOLD}${model_color}${model_display}${RESET}"
colored_prefix+=" ${sep} "
if [ "$inc_par" = 1 ] && [ -n "$dir_parent" ]; then
  colored_prefix+="${FG_DARK_ORANGE}${dir_parent}${RESET}${DIM}/${RESET}"
fi
dir_show=$(truncate_str "${dir_current:-unknown}" "$d_max")
colored_prefix+="${FG_YELLOW}${dir_show}${RESET}"

if [ -n "$branch" ]; then
  colored_prefix+=" ${sep} "
  branch_show=$(truncate_str "$branch" "$b_max")
  colored_prefix+="${FG_MAGENTA}${branch_show}${RESET}"
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
bar_outer=2  # brackets [ ]
available=$((cols - visible_len - bar_outer))
if [ "$available" -lt 4 ]; then
  available=4
fi

# Sub-cell precision: each cell = 8 eighths, so the boundary cell
# can render a fractional block for smoother growth.
total_eighths=$(( available * 8 ))
filled_eighths=$(( total_eighths * used_int / 100 ))
full_cells=$(( filled_eighths / 8 ))
remainder=$(( filled_eighths % 8 ))
empty=$(( available - full_cells - (remainder > 0 ? 1 : 0) ))

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

printf "%b%b\n" "$colored_prefix" "$bar"
