# noahs-claude-statusline

A custom status line for [Claude Code](https://claude.com/claude-code) on Linux (and WSL) and on Windows (Git Bash / MSYS2), with a smooth fractional progress bar, real terminal-width detection, and optional support for running several Claude Code accounts side by side, with a dashboard that forecasts their rate limits.

## What it shows

```
Work │ Opus 4.7 ◕ │ Github/my-project │ feature-branch*↑2 │ 5h:42% 7d:18% │ cold 640k │ 47% [██████▎░░░░░░░]
```

- **Account** (optional) — which Claude Code profile the session runs under, in that profile's colour. Only with an [accounts config](#several-accounts).
- **Model name** — a per-character gradient between two family-tinted colours (Opus magenta→violet, Sonnet cyan→indigo, Haiku lime→teal). The `(1M context)` suffix is dropped; the bar already shows how full the window is.
- **Reasoning effort** — one symbol after the model: `○` low, `◔` medium, `◑` high, `◕` xhigh, `●` max. It follows `/effort` mid-session and is absent for models without an effort setting.
- **Parent/current dir** — two-tone (parent in dark orange, current in bold yellow), from the working directory.
- **Git branch** — purple→blue gradient, with `*` for dirty, `↑N` ahead, `↓N` behind; the short SHA on a detached HEAD.
- **Rate limits** — 5h and 7d windows when present, coloured on the same smooth green→red gradient as the bar.
- **Prompt cache** — only when it matters: `cache 7m` (amber) once the one-hour cache has 10 minutes or less left, then `cold 640k` (blue): how many tokens the next turn will write back into the cache. Every request re-reads the conversation from the cache, and re-writing a lapsed one costs more than reading it, so a long session left idle is cheaper to `/compact` before you carry on. Not shown for the five-minute cache, which is cold after any pause.
- **Context %** — number plus a sub-cell-precision progress bar that grows in eighths.

When the terminal is too narrow, segments go in this order: rate limits, git ahead/behind, the parent dir, a first truncation of branch and dir, the cache warning, a second truncation, then the bar.

## Files

| File | Purpose |
|---|---|
| `statusline-linux.sh` | Entry script for Linux and WSL. Finds the terminal's width from `/proc`. |
| `statusline.sh` | Entry script for Windows. Reads this session's width from the cache the `Stop` hook writes (`~/.claude/.statusline-cols-<session_id>`). |
| `lib/render.sh` | Draws the line. Both entry scripts source it, so a change lands once. |
| `width-hook.sh` | Windows only: the `Stop` hook. Runs the probe and writes the per-session width cache. |
| `width-probe.ps1` | Windows only: PowerShell probe that walks the process tree to find the real terminal width. |
| `test-statusline.sh` | Visual harness. Renders fixed payloads so the colour ramps, the sub-cell bar boundary, the effort and cache states and the narrow-terminal degradation can be checked without waiting for a real session to reach them. |
| `config.example.json` | An example accounts config (see below). |
| `usage/` | The usage logger and dashboard (see below). |

## Install

Requires `jq` and `git` on `PATH`.

### Linux and WSL

Clone it wherever you keep tools and point `~/.claude/settings.json` at it:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bash /path/to/noahs-claude-statusline/statusline-linux.sh",
    "refreshInterval": 30
  }
}
```

The status line subprocess has no controlling terminal of its own (`$COLUMNS` is empty and `/dev/tty` fails), but an ancestor process — the shell or terminal emulator — still holds an fd on the real pts, whose live window size the kernel exposes. `statusline-linux.sh` walks up `/proc` (via the ppid in each `/proc/PID/stat`), checks fds `0/1/2/255` of each ancestor for a `/dev/pts/*` device, and reads its size with `stty size`. That's a few microseconds of `/proc` reads, so it runs on every render with no hook. It falls back to 120 columns if no pts-holding ancestor is found.

### Windows (Git Bash / MSYS2)

Claude Code's stdin JSON does not include the terminal width, and on Windows the status line subprocess cannot get it via `tput`, `stty`, `/dev/tty` or `$COLUMNS` — there is no TTY in its stdio. Naive PowerShell (`$Host.UI.RawUI.WindowSize.Width`) also lies and returns 120 (a phantom console allocated to the PowerShell subprocess). So a `Stop` hook walks up the parent process tree, calling `AttachConsole(parent_pid)` and `CreateFile("CONOUT$")` for each ancestor, and reads the screen-buffer info of the highest ancestor with a real console — the terminal you see — into a per-session cache.

```json
{
  "statusLine": {
    "type": "command",
    "command": "bash /c/Github/noahs-claude-statusline/statusline.sh",
    "refreshInterval": 30
  },
  "hooks": {
    "Stop": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "bash /c/Github/noahs-claude-statusline/width-hook.sh" } ] }
    ]
  }
}
```

Use MSYS2-style `/c/...` paths, not `C:\...`, and restart Claude Code (hooks register at session start). The first render uses the 120 fallback until the first `Stop` hook fires; after that, resize the terminal whenever and the bar adjusts on the next response. Needs Windows 10/11, Git for Windows' bash (or MSYS2) and PowerShell 5.1+.

`refreshInterval` (seconds) redraws the line while a session is idle, which is what lets the cache countdown move. The script takes well under 100 ms.

## Several accounts

If you run Claude Code under more than one profile (`CLAUDE_CONFIG_DIR`), a config file names them. It lives outside this repo, so nothing about one machine is committed:

`$CLAUDE_STATUSLINE_CONFIG`, else `$XDG_CONFIG_HOME/claude-statusline/config.json`, else `~/.config/claude-statusline/config.json`.

```json
{
  "accounts": [
    { "id": "personal", "label": "Personal", "configDir": "~/.claude", "color": [110, 220, 130] },
    { "id": "work", "label": "Work", "configDir": "~/.claude-work", "color": [255, 165, 60] }
  ],
  "usage": {
    "log": true,
    "dashboard": "~/claude-usage/usage-dashboard.html"
  }
}
```

- **The account segment** is the account whose `configDir` holds the session's transcript (matched on the folder's name, so Windows paths work too), else the one at `CLAUDE_CONFIG_DIR`, else the one at `~/.claude`. It is read by the same `jq` call as the payload, so it costs nothing extra. With no config, or one that doesn't parse, the line is drawn without it.
- **`usage.log: true`** records each account's rate limits for the dashboard (needs [bun](https://bun.sh) at `~/.bun/bin/bun` or on `PATH`).
- **`usage.dashboard`** is where the dashboard is written; default `usage/dist/usage-dashboard.html`.
- **`usage.windowsHome`** (WSL only) is the Windows user folder whose `.claude*` profiles also log usage, for a machine where Claude Code runs on both sides; their readings are merged into the dashboard.

## Usage logging and dashboard (`usage/`)

**Logging.** At most once every 5 minutes per account, the status line launches `usage/src/log.ts` in the background with the 5-hour and 7-day `used_percentage` and `resets_at` values. It appends a row to `usage.db` in that account's config folder, then regenerates the dashboard. The throttle is fork-free (a stamp file read with the `read` builtin), so the hot path costs nothing extra. Claude Code can cancel a status-line run mid-flight, killing the background process with it, so the status line's stamp only defers a retry by a minute; `log.ts` pushes it out to 5 minutes once the row is written. Failures go to `~/.claude/.usage-log-errors.log`.

Readings are stored raw. Every open session reports the limits from its own last API response, so idle sessions report stale, lower figures; the dashboard takes a running maximum within each window to remove them. The readings never enter this repo: they live in each profile's folder, the built dashboard (which inlines them) is in the ignored `usage/dist/`, and `*.db` is ignored too.

**Dashboard.**

```bash
cd usage
bun install          # dev types only; the dashboard has no runtime dependencies
bun run build        # bundle the client and write the dashboard
bun run open         # build, then open it
bun test             # model tests
```

The dashboard is one self-contained HTML file with the data inlined. It is rewritten after every logged reading and reloads itself every 5 minutes. All forecasting runs in the page, so every setting applies instantly and is remembered in the browser.

- **All accounts**: how much more (or less) you can use across all accounts before any of them reaches the ceiling (95% by default). Each account burns its own forecast until it hits the ceiling; from then on its usage is shared evenly between the accounts that still have room. Also shows when each account hits the ceiling, how much load moves between accounts, and daily usage.
- **Per account**: the current window against earlier windows, forecast at reset with the spread across models, when it reaches 95% and 100%, a pace budget per weekday, the 5-hour window, and a model table with backtest accuracy (every finished window replayed from 1–6 days in).
- **Weekends**: weekday vs weekend usage per full week, the reduction your history implies, and per-account overrides of the global weekend setting (default 80% less).

Models: **Flat pace** (average since the reset, optionally including prior weeks), **Recent pace** (last N days), **Weekday pattern** (per-weekday profile scaled to this week), **Linear trend**, **Smoothed trend** (Holt–Winters with damped trend), and **Blend** (their average). "Learn from prior weeks", the number of weeks and the recency half-life control how much history they use. Weekends are always weekday usage × (1 − weekend reduction), so the weekend setting means the same thing in every model.

With `usage.windowsHome` set, `bun run import-windows` (try `--dry-run` first) copies the Windows profiles' rows into the Linux databases, after which you can remove `windowsHome`.

| File | Purpose |
|---|---|
| `usage/src/config.ts` | Reads the accounts config |
| `usage/src/log.ts` | Called by the status line; writes one reading and refreshes the dashboard |
| `usage/src/db.ts` | `usage.db` schema, inserts and reads |
| `usage/src/accounts.ts` | The tracked accounts, from the config |
| `usage/src/windows.ts`, `import-windows.ts` | WSL: merge or import the Windows profiles' readings |
| `usage/src/model/` | Series cleaning, forecast models, sharing simulation, weekend stats, backtest |
| `usage/src/client/` | Dashboard UI (vanilla TS + SVG charts) |
| `usage/src/build.ts`, `render.ts` | Bundle the client; render the HTML with the data inlined |

## Customization

The knobs are in `lib/render.sh`:

- **Fallback width** (`STATUSLINE_COLS=120`) — used when the entry script can't find the width. `CLAUDE_STATUSLINE_COLS` fixes it (the harness uses this).
- **Model colours** — the `case "$model_id"` block, which sets each family's start/end RGB for the name gradient.
- **Effort symbols** — the `case "$effort"` block.
- **Bar & rate-limit colours** — the `grad_color` anchor stops (`stops=(0 80 200 100  …)`, read as `pct R G B`). Move a stop's percentage to shift where green→yellow→orange→red lands, or change its RGB to retint.
- **Boundary-cell BG** (`bar_empty_bg`) — dark grey fill behind the partial-block character so it doesn't look like a gap. Try `233`–`238` for darker/lighter.
- **Bar character set** — change the `partial_char` table or the `█`/`░` glyphs in the fill/empty loops.

## Limitations / notes

- Claude Code redraws the line on events (a new message, a tool finishing, a permission-mode change); `refreshInterval` adds a timer for idle sessions.
- `permissionMode` (the Shift+Tab state) is not exposed to status lines and the transcript only logs it on session start and message boundaries, not on toggles, so there is no live lock indicator.
- The PowerShell probe takes ~200–500 ms cold-start, so it runs in the `Stop` hook (once per response, with a 5-second timeout), never in the status line itself.
- If the bar ever picks a wrong width on Windows, look at `~/.claude/.statusline-width-debug.log` — it lists every ancestor walked and which had usable consoles.
