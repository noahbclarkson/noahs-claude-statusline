# noahs-claude-statusline

A custom statusline for [Claude Code](https://claude.com/claude-code) on Windows MSYS2 bash, with smooth fractional progress bar and proper terminal-width detection.

## What it shows

```
Claude Opus 4.7 (1M) │ Github/my-project │ feature-branch*↑2 │ 5h:42% 7d:18% │ 47% [██████▎░░░░░░░]
```

- **Model name** — color-coded by family (Opus magenta, Sonnet cyan, Haiku green)
- **Parent/current dir** — two-tone (parent in dark orange, current in yellow)
- **Git branch** — with `*` for dirty, `↑N` ahead, `↓N` behind
- **Rate limits** — 5h and 7d windows when present, color-graded green/yellow/red
- **Context %** — number plus a sub-cell-precision progress bar that grows in eighths

## Why this exists

Claude Code's stdin JSON does not expose terminal width, and the statusline subprocess on Windows MSYS2 bash cannot get it via `tput`, `stty`, `/dev/tty`, or `$COLUMNS` — they all fail because there's no TTY in its stdio. Naive PowerShell (`$Host.UI.RawUI.WindowSize.Width`) also lies and returns 120 (a phantom default console allocated to the PowerShell subprocess).

This repo solves it by walking up the parent process tree from a `Stop` hook, calling `AttachConsole(parent_pid)` and `CreateFile("CONOUT$")` for each ancestor, and reading the screen-buffer info of the *last* (highest) ancestor that has a real console — which is the actual terminal the user sees.

## Files

| File | Purpose |
|---|---|
| `statusline.sh`   | The statusline itself. Reads cached width from `~/.claude/.statusline-cols`. |
| `width-hook.sh`   | `Stop` hook entry point. Drains stdin, runs the probe, writes the cache. |
| `width-probe.ps1` | PowerShell probe that walks the process tree to find the real terminal width. |

State files (written at runtime, not in the repo):

- `~/.claude/.statusline-cols` — cached terminal width
- `~/.claude/.statusline-width-debug.log` — overwritten every probe run, useful when the chain heuristic picks the wrong ancestor

## Install

1. **Clone wherever you keep tools:**
   ```bash
   git clone <this-repo> /c/Github/noahs-claude-statusline
   ```

2. **Wire it into `~/.claude/settings.json`** (create the file if it doesn't exist):
   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "bash /c/Github/noahs-claude-statusline/statusline.sh"
     },
     "hooks": {
       "Stop": [
         {
           "matcher": "",
           "hooks": [
             {
               "type": "command",
               "command": "bash /c/Github/noahs-claude-statusline/width-hook.sh"
             }
           ]
         }
       ]
     }
   }
   ```
   Adjust the paths if you cloned elsewhere. Use MSYS2-style `/c/...` paths, not `C:\...`.

3. **Restart Claude Code.** Hooks register at session start; settings changes mid-session don't pick up new hooks.

4. **First render uses the 120 fallback** until the first `Stop` hook fires (after your first agent response). After that, it stays in sync — resize the terminal whenever, the bar adjusts on the next response.

## Requirements

- Claude Code
- Windows 10/11 (the AttachConsole walk is Windows-specific)
- MSYS2 bash — Git for Windows ships one that works
- PowerShell 5.1+ (built-in)
- `jq` and `git` on `PATH`

If you're on macOS or Linux, the width-probe layer isn't needed — the statusline can read `tput cols` directly. This repo doesn't currently include that path; PRs welcome.

## Customization

All knobs are at the top of `statusline.sh`:

- **Fallback width** (`STATUSLINE_COLS=120`) — used before the cache is populated, or if the probe ever fails.
- **Model colors** — the `case "$model_id"` block.
- **Bar fill thresholds & colors** — the `if [ "$used_int" -lt 50 ]` ladder. Swap the ANSI codes (`\033[92m` etc.) to taste.
- **Boundary-cell BG** (`bar_empty_bg="\033[48;5;236m"`) — dark gray fill behind the partial-block character so it doesn't look like a gap. Try `233`–`238` for darker/lighter.
- **Bar character set** — change the `partial_char` table or the `█`/`░` glyphs in the fill/empty loops.

## Limitations / notes

- Statusline refresh cadence is roughly every 10 seconds in idle sessions, faster around tool boundaries. Any animation or "live" indicator looks janky — don't bother.
- `permissionMode` (the Shift+Tab state) is not exposed to statuslines and the transcript file only logs it on session start / message boundaries, not on toggles. There's no way to render a live lock indicator.
- The PowerShell probe takes ~200–500 ms cold-start. That's fine in a `Stop` hook (once per response) but never call it from `statusline.sh` itself.
- If the bar ever picks a wrong width, look at `~/.claude/.statusline-width-debug.log` — it lists every ancestor walked and which had usable consoles.
