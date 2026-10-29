// The Claude Code profiles being tracked, from the local config (config.ts).
// `id` is what the status line passes to log.ts; `configDir` is the profile's
// CLAUDE_CONFIG_DIR, where usage.db lives. With no accounts configured, the one
// default profile is tracked.

import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG, expandHome } from "./config";

export interface Account {
  id: string;
  label: string;
  configDir: string;
}

export const ACCOUNTS: Account[] = CONFIG.accounts?.length
  ? CONFIG.accounts.map((a) => ({ id: a.id, label: a.label, configDir: expandHome(a.configDir) }))
  : [{ id: "default", label: "Claude", configDir: process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude") }];

export const accountById = (id: string): Account | undefined => ACCOUNTS.find((a) => a.id === id);
