#!/usr/bin/env bash
# Visual test harness for statusline.sh.
#
# Renders the statusline against fixed payloads so the color ramps, the
# sub-cell bar boundary and the narrow-terminal degradation can be eyeballed
# without waiting for real sessions to drift into those states. Nothing here
# asserts — read the output.
#
# The width section drives STATUSLINE_COLS the same way the real Stop hook
# does, by writing the per-session cache file, and removes what it wrote.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATUSLINE="$SCRIPT_DIR/statusline.sh"
CACHE_DIR="$HOME/.claude"
SESSION="statusline-harness"
CACHE_FILE="$CACHE_DIR/.statusline-cols-$SESSION"

cleanup() { rm -f "$CACHE_FILE"; }
trap cleanup EXIT

heading() { printf '\n\033[1;36m%s\033[0m\n' "$1"; }
label()   { printf '\033[2m%-34s\033[0m' "$1"; }

# $1 label, $2 payload
render() {
  label "$1"
  printf '%s' "$2" | bash "$STATUSLINE"
}

payload() { # $1 model_id, $2 display, $3 context %, $4 5h %, $5 7d %
  cat <<JSON
{
  "model": { "id": "$1", "display_name": "$2" },
  "workspace": { "project_dir": "$SCRIPT_DIR" },
  "session_id": "$SESSION",
  "context_window": { "used_percentage": $3 },
  "rate_limits": {
    "five_hour": { "used_percentage": $4 },
    "seven_day": { "used_percentage": $5 }
  }
}
JSON
}

# A wide terminal for everything except the degradation section, so the bar
# has room and the only variable is the payload.
printf '120\n' > "$CACHE_FILE"

heading "Model gradients"
render "Opus"    "$(payload claude-opus-4-5   'Claude Opus 4.7 (1M context)' 47 42 18)"
render "Sonnet"  "$(payload claude-sonnet-4-5 'Claude Sonnet 4.5'            47 42 18)"
render "Haiku"   "$(payload claude-haiku-4-5  'Claude Haiku 4.5'             47 42 18)"
render "unknown" "$(payload some-other-model  'Some Other Model'             47 42 18)"

heading "Context fill — bar color ramp and sub-cell boundary"
for pct in 0 3 17 38 55 61 74 80 93 100; do
  render "used_percentage=$pct" "$(payload claude-opus-4-5 'Claude Opus 4.7' "$pct" 20 10)"
done

heading "Rate-limit color ramp"
for pct in 5 40 60 85 99; do
  render "5h=$pct 7d=$pct" "$(payload claude-opus-4-5 'Claude Opus 4.7' 30 "$pct" "$pct")"
done

heading "Fractional percentages"
render "used_percentage=47.4" "$(payload claude-opus-4-5 'Claude Opus 4.7' 47.4 42 18)"
render "used_percentage=47.6" "$(payload claude-opus-4-5 'Claude Opus 4.7' 47.6 42 18)"

heading "Narrow terminals — degradation ladder"
echo "Rate limits go first, then git ahead/behind, then the parent dir, then"
echo "the branch and dir are truncated, then the bar is dropped. Each line is"
echo "printed under a ruler of the width it was rendered for, so anything that"
echo "overruns the ruler would have wrapped in a real terminal."
# Ruler marking every 10th cell, so an overrun is visible at a glance.
ruler() {
  local n=$1 i out=""
  for ((i = 1; i <= n; i++)); do
    if [ $((i % 10)) -eq 0 ]; then out+="|"; else out+="-"; fi
  done
  printf '%s' "$out"
}
for cols in 120 100 84 72 60 48 36 24; do
  printf '%s
' "$cols" > "$CACHE_FILE"
  printf '
[2m%s  (cols=%s)[0m
' "$(ruler "$cols")" "$cols"
  printf '%s' "$(payload claude-opus-4-5 'Claude Opus 4.7 (1M)' 47 42 18)" | bash "$STATUSLINE"
done
echo

heading "Missing fields"
printf '120\n' > "$CACHE_FILE"
render "no rate limits" '{
  "model": { "id": "claude-opus-4-5", "display_name": "Claude Opus 4.7" },
  "workspace": { "project_dir": "'"$SCRIPT_DIR"'" },
  "session_id": "'"$SESSION"'",
  "context_window": { "used_percentage": 47 }
}'
render "no workspace" '{
  "model": { "id": "claude-opus-4-5", "display_name": "Claude Opus 4.7" },
  "session_id": "'"$SESSION"'",
  "context_window": { "used_percentage": 47 }
}'
render "empty payload" '{}'

echo
