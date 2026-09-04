#!/usr/bin/env bash
# Assertion tests for the rate-limit reset countdown.
# Countdown renders only when a window is at or above RESET_COUNTDOWN_THRESHOLD (80%).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pass=0; fail=0
now=$(date +%s)

# Strip ANSI so assertions match on plain text.
render() {
  printf '%s' "$1" | bash "$SCRIPT_DIR/statusline.sh" | sed $'s/\033\[[0-9;]*m//g'
}

payload() { # $1=five_pct $2=five_resets $3=week_pct $4=week_resets
  local five_r="" week_r=""
  [ -n "$2" ] && five_r=", \"resets_at\": $2"
  [ -n "$4" ] && week_r=", \"resets_at\": $4"
  cat <<JSON
{
  "model": { "id": "claude-opus-5", "display_name": "Opus 5" },
  "workspace": { "project_dir": "$SCRIPT_DIR" },
  "session_id": "test-countdown",
  "context_window": { "used_percentage": 30, "used_tokens": 300000, "total_tokens": 1000000 },
  "rate_limits": {
    "five_hour": { "used_percentage": $1$five_r },
    "seven_day": { "used_percentage": $3$week_r }
  }
}
JSON
}

assert_has() { # $1=desc $2=output $3=needle
  if [[ "$2" == *"$3"* ]]; then
    echo "  PASS  $1"; pass=$((pass+1))
  else
    echo "  FAIL  $1"; echo "        expected to contain: [$3]"; echo "        got: [$2]"; fail=$((fail+1))
  fi
}
assert_lacks() {
  if [[ "$2" != *"$3"* ]]; then
    echo "  PASS  $1"; pass=$((pass+1))
  else
    echo "  FAIL  $1"; echo "        expected NOT to contain: [$3]"; echo "        got: [$2]"; fail=$((fail+1))
  fi
}

echo "Rate-limit reset countdown"

out=$(render "$(payload 41 $((now + 14190)) 23 $((now + 342000)))")
assert_lacks "below threshold: no countdown on 5h:41%" "$out" "5h:41% ·"
assert_has   "below threshold: percent still shown"    "$out" "5h:41%"

out=$(render "$(payload 103 $((now + 14190)) 23 $((now + 342000)))")
assert_has   "over limit: 5h:103% shows 3h56m countdown" "$out" "5h:103% ·3h56m"
assert_lacks "over limit: quiet 7d:23% stays bare"       "$out" "7d:23% ·"

out=$(render "$(payload 80 $((now + 3630)) 23 "")")
assert_has "at threshold 80%: countdown renders" "$out" "5h:80% ·1h0m"

out=$(render "$(payload 79 $((now + 3630)) 23 "")")
assert_lacks "just under threshold 79%: no countdown" "$out" "5h:79% ·"

out=$(render "$(payload 95 $((now + 2850)) 88 $((now + 353030)))")
assert_has "sub-hour window renders as minutes"  "$out" "5h:95% ·47m"
assert_has "multi-day window renders as d+h"     "$out" "7d:88% ·4d2h"

out=$(render "$(payload 99 "" 23 "")")
assert_has "missing resets_at: percent still renders" "$out" "5h:99%"
assert_lacks "missing resets_at: no countdown"        "$out" "5h:99% ·"

out=$(render "$(payload 99 $((now - 500)) 23 "")")
assert_lacks "elapsed resets_at: no negative countdown" "$out" "·-"
assert_has   "elapsed resets_at: percent still renders" "$out" "5h:99%"

echo ""
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
