// Assembles the dashboard HTML: the prebuilt app bundle and stylesheet plus a
// snapshot of every profile's usage.db, inlined into one file. Cheap enough
// (~100 ms) for log.ts to call after every write, so the file is never more
// than one log interval behind.
//
// Where it goes: CLAUDE_USAGE_DASHBOARD, else the config's usage.dashboard
// (config.ts), else dist/usage-dashboard.html. Under WSL, a path on the Windows
// drive lets a Windows browser keep one bookmark to it.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ACCOUNTS } from "./accounts";
import { CONFIG, expandHome } from "./config";
import { readSamples } from "./db";

export const ROOT = join(import.meta.dir, "..");
export const DIST = join(ROOT, "dist");
export const OUT_FILE = expandHome(
  process.env.CLAUDE_USAGE_DASHBOARD || CONFIG.usage?.dashboard || join(DIST, "usage-dashboard.html"),
);

export interface Payload {
  generatedAt: number;
  accounts: { id: string; label: string; samples: ReturnType<typeof readSamples> }[];
}

export function renderDashboard(): string {
  const js = join(DIST, "app.js");
  const css = join(DIST, "app.css");
  if (!existsSync(js) || !existsSync(css)) throw new Error("dist/app.js missing — run `bun run build` first");

  const payload: Payload = {
    generatedAt: Math.floor(Date.now() / 1000),
    accounts: ACCOUNTS.map((a) => ({ id: a.id, label: a.label, samples: readSamples(a) })),
  };
  // `<` escaped so the JSON can never close its <script> element.
  const data = JSON.stringify(payload).replace(/</g, "\\u003c");
  const html = readFileSync(join(ROOT, "src", "client", "template.html"), "utf8")
    .replace("/*__CSS__*/", () => readFileSync(css, "utf8"))
    .replace("__DATA__", () => data)
    .replace("/*__APP__*/", () => readFileSync(js, "utf8").replace(/<\/script/gi, "<\\/script"));

  // Write-then-rename so a browser reloading mid-write never sees half a file.
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  const tmp = `${OUT_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, html);
  renameSync(tmp, OUT_FILE);
  return OUT_FILE;
}
