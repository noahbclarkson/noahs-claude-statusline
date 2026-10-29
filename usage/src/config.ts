// The local configuration: which Claude Code profiles exist on this machine and
// where the dashboard goes. It lives outside the repo, so the repo carries
// nothing about any one machine:
//
//   $CLAUDE_STATUSLINE_CONFIG, else $XDG_CONFIG_HOME/claude-statusline/config.json,
//   else ~/.config/claude-statusline/config.json
//
// The status line reads the same file. See config.example.json and the README.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AccountConfig {
  id: string;
  label: string;
  /** The profile's CLAUDE_CONFIG_DIR; a leading ~ is the home directory. */
  configDir: string;
  /** The account name's colour in the status line, as [r, g, b]. */
  color?: [number, number, number];
}

export interface Config {
  accounts?: AccountConfig[];
  usage?: {
    /** Whether the status line records each account's rate limits (needs bun). */
    log?: boolean;
    /** Where the dashboard HTML is written; default usage/dist/usage-dashboard.html. */
    dashboard?: string;
    /**
     * On Linux under WSL: the Windows user folder whose .claude* profiles also
     * log usage, merged into the dashboard (see windows.ts). Absent = off.
     */
    windowsHome?: string;
  };
}

export const CONFIG_PATH =
  process.env.CLAUDE_STATUSLINE_CONFIG ||
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "claude-statusline", "config.json");

export const expandHome = (p: string): string =>
  p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;

export const CONFIG: Config = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {};
