# Claude Code status line: the drawing, shared by both entry scripts.
#
#   statusline-linux.sh  Linux and WSL: reads the terminal's width from /proc
#   statusline.sh        Windows (Git Bash / MSYS2): reads the width the Stop hook cached
#
# Each entry script defines find_cols, which sets STATUSLINE_COLS when it can
# find the terminal's width, and $here, its own folder, then sources this
# file. Sourcing costs no fork.
#
# Layout: [account |] model [effort] | parent/dir | branch[*↑↓] | rate-limits | [cache |] context% [bar]
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

# --- Accounts (optional): which Claude Code profile this session runs under ---
# A config file outside this repo names each profile (CLAUDE_CONFIG_DIR) with a
# label and colour, and says whether to log usage; see config.example.json.
# Without one there is no account segment and no usage logging. The same jq
# call as the payload reads it, so it costs no extra process.
statusline_config="${CLAUDE_STATUSLINE_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/claude-statusline/config.json}"

# --- Parse all stdin JSON fields in a single jq call (perf: fork is expensive on Windows) ---
# The account is the one whose config folder holds this session's transcript
# (matched on the folder's name, so Windows backslash paths work too), else the
# one at CLAUDE_CONFIG_DIR, else the one at ~/.claude.
jq_program='
  def norm: gsub("\\\\"; "/") | sub("/+$"; "");
  def base: split("/") | last;
  (($cfg[0].accounts? // []) | map(. + {dir: ((.configDir // "") | sub("^~"; $home) | norm)})) as $accounts
  | ((.transcript_path // "") | norm) as $tp
  | (($ENV.CLAUDE_CONFIG_DIR // "") | sub("^~"; $home) | norm) as $env_dir
  | ((if $tp != "" then
        first($accounts[] | select(.dir != "") | (.dir | base) as $b | select($tp | contains("/" + $b + "/")))
      else
        first($accounts[] | select(.dir == (if $env_dir != "" then $env_dir else ($home | norm) + "/.claude" end)))
      end) // null) as $acct
  |
  @sh "model_id=\(.model.id // "")",
  @sh "model_display=\(.model.display_name // "Claude")",
  @sh "work_dir=\(.workspace.current_dir // .cwd // "")",
  @sh "launch_dir=\(.workspace.project_dir // "")",
  @sh "session_id=\(.session_id // "")",
  @sh "used_pct=\(.context_window.used_percentage // 0)",
  @sh "five_pct_raw=\(.rate_limits.five_hour.used_percentage // "")",
  @sh "five_reset_raw=\(.rate_limits.five_hour.resets_at // "")",
  @sh "week_pct_raw=\(.rate_limits.seven_day.used_percentage // "")",
  @sh "week_reset_raw=\(.rate_limits.seven_day.resets_at // "")",
  @sh "account=\($acct.label // "")",
  @sh "account_id=\($acct.id // "")",
  @sh "account_dir=\($acct.dir // "")",
  @sh "account_rgb=\(($acct.color // []) | map(tostring) | join(";"))",
  @sh "usage_log=\(if ($cfg[0].usage.log? // false) == true then "1" else "" end)",
  @sh "effort=\(.effort.level // "")",
  @sh "cache_seen=\(if .prompt_cache.caching_observed == true then "1" else "" end)",
  @sh "cache_ttl=\(.prompt_cache.ttl // "")",
  @sh "cache_warm=\(.prompt_cache.warm | if . == null then "" else tostring end)",
  @sh "cache_expires=\(.prompt_cache.expires_at | if type == "number" then floor else "" end)",
  @sh "cache_recache=\(.prompt_cache.recache_tokens_if_cold | if type == "number" then floor else "" end)"
'
parsed=""
if [ -r "$statusline_config" ]; then
  parsed=$(printf '%s' "$input" | jq -r --arg home "$HOME" --slurpfile cfg "$statusline_config" "$jq_program" 2>/dev/null)
fi
# No config, or one jq can't read: draw the line without accounts rather than
# not at all.
if [ -z "$parsed" ]; then
  parsed=$(printf '%s' "$input" | jq -r --arg home "$HOME" --argjson cfg '[]' "$jq_program" 2>/dev/null)
fi
eval "$parsed"

# --- Terminal width ---
# CLAUDE_STATUSLINE_COLS fixes it (test-statusline.sh uses it). Otherwise the
# entry script's find_cols sets STATUSLINE_COLS when it finds the width, and
# the 120 fallback stands when it doesn't.
if [[ "${CLAUDE_STATUSLINE_COLS:-}" =~ ^[0-9]+$ ]]; then
  STATUSLINE_COLS=$CLAUDE_STATUSLINE_COLS
else
  find_cols
fi

# --- Usage log: one rate-limit reading per account every 5 minutes ---
# Written to <profile>/usage.db by usage/src/log.ts, which also refreshes the
# dashboard (see usage/src/render.ts for where it is written). The throttle is
# fork-free: a stamp file holding the last log time, read with the `read`
# builtin, so the only cost on the hot path is a background bun once per 5 minutes.
# Claude Code can cancel a status-line run mid-flight (busy sessions refresh
# often), taking the background bun with it. So the stamp written here only
# holds off a retry for a minute; log.ts moves it on 5 minutes once the row
# is safely in the database.
printf -v now_s '%(%s)T' -1
if [ -n "$usage_log" ] && [ -n "$account_id" ] && [ -n "$account_dir" ] && [ -n "$five_pct_raw$week_pct_raw" ]; then
  stamp="$account_dir/.usage-log-stamp"
  last_s=0
  [ -r "$stamp" ] && read -r last_s < "$stamp"
  [[ "$last_s" =~ ^[0-9]+$ ]] || last_s=0
  if (( now_s - last_s >= 300 )); then
    printf '%s\n' "$((now_s - 240))" > "$stamp"
    # Absolute path: the status line's PATH need not include ~/.bun/bin.
    bun_bin="$HOME/.bun/bin/bun"
    [ -x "$bun_bin" ] || bun_bin=bun
    # Fully detached: Claude Code must not wait on it for the status line.
    "$bun_bin" "${here:-.}/usage/src/log.ts" "$account_id" \
      "$five_pct_raw" "$five_reset_raw" "$week_pct_raw" "$week_reset_raw" "$session_id" \
      </dev/null >/dev/null 2>&1 &
  fi
fi

# --- Account name colour: the config's [r, g, b], else a neutral grey ---
account_color=$'\033'"[38;2;${account_rgb:-200;200;200}m"

# --- Shorten verbose model display names ---
# The window's size isn't worth the room: the bar already says how full it is.
model_display="${model_display/ (1M context)/}"

# --- Reasoning effort: one symbol after the model, filling as effort rises ---
# Absent when the model takes no effort setting. Follows /effort mid-session.
case "$effort" in
  low)    effort_glyph="○" ;;
  medium) effort_glyph="◔" ;;
  high)   effort_glyph="◑" ;;
  xhigh)  effort_glyph="◕" ;;
  max)    effort_glyph="●" ;;
  *)      effort_glyph="" ;;
esac

# --- Prompt cache: only when it has gone cold, or will within 10 minutes ---
# Each request re-reads the whole conversation from the prompt cache; once its
# one-hour lifetime runs out, the next turn writes all of it back, which costs
# more than reading it. "cache 7m" is the warning; "cold 640k" is how much the
# next turn will write. Only for the one-hour cache: the five-minute one is
# cold after any pause, so the segment would never go away. Needs Claude
# Code's statusLine.refreshInterval to count down while a session is idle.
fmt_tokens() {  # sets tok_str: 640123 -> 640k, 1234567 -> 1.2M
  local n=$1 t
  if (( n >= 999500 )); then
    t=$(( (n + 50000) / 100000 ))
    tok_str="$((t / 10)).$((t % 10))M"
  elif (( n >= 1000 )); then
    tok_str="$(( (n + 500) / 1000 ))k"
  else
    tok_str="$n"
  fi
}
cache_plain=""
cache_color=""
if [ -n "$cache_seen" ] && [ "$cache_ttl" = "1h" ]; then
  if [ "$cache_warm" = "false" ] || { [[ "$cache_expires" =~ ^[0-9]+$ ]] && (( now_s >= cache_expires )); }; then
    cache_plain="cold"
    if [[ "$cache_recache" =~ ^[0-9]+$ ]] && (( cache_recache > 0 )); then
      fmt_tokens "$cache_recache"
      cache_plain+=" $tok_str"
    fi
    cache_color=$'\033[38;2;110;170;255m'   # cold blue
  elif [[ "$cache_expires" =~ ^[0-9]+$ ]] && (( cache_expires - now_s <= 600 )); then
    cache_plain="cache $(( (cache_expires - now_s + 59) / 60 ))m"
    cache_color=$'\033[38;2;255;175;60m'    # amber
  fi
fi

# --- Model name: per-family endpoints for a left-to-right gradient ---
case "$model_id" in
  *opus*)   model_rgb=(255 95 215  115 100 255) ;;  # magenta → violet-blue
  *sonnet*) model_rgb=(70 230 235  105 120 255) ;;  # cyan → indigo
  *haiku*)  model_rgb=(175 240 90   55 205 185) ;;  # lime → teal
  *)        model_rgb=(70 230 235  105 120 255) ;;
esac

# --- Folder: which repository (and worktree) the session is working in ---
# Not the folder it has cd'd into ("apps/web" says nothing about which checkout
# that is): walk up from the working directory to the folder holding .git,
# fork-free. In a linked worktree, whose .git file points into the main repo's
# .git/worktrees/, the segment reads repo/worktree ("my-repo/feature-x"); in a
# main checkout, parent/repo. Outside git, the folder Claude Code was launched
# in. Claude Code sends Windows paths with backslashes ("C:\Users\me\proj");
# normalising to forward slashes costs nothing on a POSIX path.
work_dir="${work_dir//\\//}";     work_dir="${work_dir%/}"
launch_dir="${launch_dir//\\//}"; launch_dir="${launch_dir%/}"
project_dir="${work_dir:-$launch_dir}"   # where the walk to .git starts
repo_root=""
check_dir="$project_dir"
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  [ -z "$check_dir" ] && break
  [ "$check_dir" = "/" ] && break
  if [ -e "$check_dir/.git" ]; then
    repo_root="$check_dir"
    break
  fi
  parent="${check_dir%/*}"
  [ "$parent" = "$check_dir" ] && break
  check_dir="$parent"
done

dir_parent=""
dir_current=""
dir_parent_kept=""   # set for a worktree: its repo's name is never dropped for room
if [ -n "$repo_root" ]; then
  dir_current="${repo_root##*/}"
  gitdir_line=""
  [ -f "$repo_root/.git" ] && read -r gitdir_line < "$repo_root/.git"
  gitdir_line="${gitdir_line//\\//}"
  if [[ "$gitdir_line" == "gitdir: "*"/.git/worktrees/"* ]]; then
    main_repo="${gitdir_line#gitdir: }"
    main_repo="${main_repo%%/.git/worktrees/*}"
    dir_parent="${main_repo##*/}"
    dir_parent_kept=1
  else
    parent="${repo_root%/*}"
    dir_parent="${parent##*/}"
  fi
else
  folder="${launch_dir:-$work_dir}"
  if [ -n "$folder" ]; then
    dir_current="${folder##*/}"
    parent="${folder%/*}"
    [ "$parent" != "$folder" ] && dir_parent="${parent##*/}"
  fi
fi

# --- Git branch + dirty indicator + ahead/behind ---
branch=""
git_suffix=""
git_dirty=""
git_ab=""
git_ab_cells=0   # visible-cell count of git_ab (arrows are 1 cell but 3 bytes in UTF-8)
if [ -n "$repo_root" ] && command -v git >/dev/null 2>&1; then
  branch=$(git -C "$repo_root" --no-optional-locks branch --show-current 2>/dev/null)
  # Detached HEAD (bisect, a checked-out tag, a rebase in flight) has no branch
  # name; the short SHA keeps the segment useful instead of blanking it.
  if [ -z "$branch" ]; then
    branch=$(git -C "$repo_root" --no-optional-locks rev-parse --short HEAD 2>/dev/null)
  fi
  if [ -n "$branch" ]; then
    if [ -n "$(git -C "$repo_root" --no-optional-locks status --porcelain 2>/dev/null)" ]; then
      git_dirty="*"
    fi
    ab=$(git -C "$repo_root" --no-optional-locks rev-list --left-right --count "@{upstream}...HEAD" 2>/dev/null)
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
#   3. parent directory (not a worktree's repo name)
#   4. truncate branch to 14, then current dir to 18
#   5. the prompt-cache warning
#   6. truncate branch to 8, then current dir to 10
#   7. drop the bar entirely
cols=$STATUSLINE_COLS
TARGET_BAR=8           # min bar interior cells we want
SEP_LEN=3              # " │ " visible width

# Compute prefix visible length (in cells) for a given configuration.
# All non-separator strings are assumed ASCII; truncation clamps to b_max/d_max
# cells (truncate_str produces exactly that many visible cells via …). The
# only multi-byte fields handled specially are the SEP_LEN constant and
# git_ab_cells, both pre-computed in cells rather than bytes; the effort symbol
# is one cell. Sets $prefix_len rather than printing it, so the loop below
# runs without a subshell per step (a fork each, slow on Windows).
# args: include_rate include_ab include_parent branch_max dir_max include_cache
prefix_visible_len() {
  local inc_rate=$1 inc_ab=$2 inc_par=$3 b_max=$4 d_max=$5 inc_cache=$6
  local n=${#model_display}
  [ -n "$effort_glyph" ] && n=$((n + 2))   # " ◕"
  [ -n "$account" ] && n=$((n + ${#account} + SEP_LEN))
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
  if [ "$inc_cache" = 1 ] && [ -n "$cache_plain" ]; then
    n=$((n + SEP_LEN + ${#cache_plain}))
  fi
  n=$((n + SEP_LEN + ${#used_int} + 2))   # " │ N% "
  prefix_len=$n
}

inc_rate=1; inc_ab=1; inc_par=1; inc_cache=1
b_max=999; d_max=999
drop_bar=0
budget=$((cols - 2 - TARGET_BAR))   # 2 for brackets

while :; do
  prefix_visible_len "$inc_rate" "$inc_ab" "$inc_par" "$b_max" "$d_max" "$inc_cache"
  [ "$prefix_len" -le "$budget" ] && break

  if [ "$inc_rate" = 1 ] && [ -n "$plain_rate" ]; then
    inc_rate=0
  elif [ "$inc_ab" = 1 ] && [ -n "$git_ab" ]; then
    inc_ab=0
  elif [ "$inc_par" = 1 ] && [ -n "$dir_parent" ] && [ -z "$dir_parent_kept" ]; then
    inc_par=0
  elif [ "$b_max" -gt 14 ] && [ -n "$branch" ] && [ "${#branch}" -gt 14 ]; then
    b_max=14
  elif [ "$d_max" -gt 18 ] && [ "${#dir_current}" -gt 18 ]; then
    d_max=18
  elif [ "$inc_cache" = 1 ] && [ -n "$cache_plain" ]; then
    inc_cache=0
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
colored_prefix=""
[ -n "$account" ] && colored_prefix+="${BOLD}${account_color}${account}${RESET} ${sep} "
colored_prefix+="${BOLD}${grad_text}${RESET}"
# The symbol takes the model gradient's end colour, so it reads as part of the name.
[ -n "$effort_glyph" ] && colored_prefix+=" "$'\033'"[38;2;${model_rgb[3]};${model_rgb[4]};${model_rgb[5]}m${effort_glyph}${RESET}"
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

if [ "$inc_cache" = 1 ] && [ -n "$cache_plain" ]; then
  colored_prefix+=" ${sep} ${cache_color}${cache_plain}${RESET}"
fi

colored_prefix+=" ${sep} "
colored_prefix+="${FG_WHITE}${used_int}%${RESET}"
colored_prefix+=" "

# Visible length in cells — matches what we used during the budget loop, so
# bar sizing stays consistent (avoids the byte-vs-cell discrepancy that
# stripping ANSI + ${#stripped} would introduce for │ separators and arrows).
prefix_visible_len "$inc_rate" "$inc_ab" "$inc_par" "$b_max" "$d_max" "$inc_cache"
visible_len=$prefix_len

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
