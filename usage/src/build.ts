// Builds the dashboard: bundles src/client into dist/app.js + dist/app.css,
// then renders the dashboard HTML (see render.ts for where) from the current databases.
//
//   bun src/build.ts          build
//   bun src/build.ts --open   build, then open the dashboard in the browser

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DIST, ROOT, renderDashboard } from "./render";

mkdirSync(DIST, { recursive: true });
const result = await Bun.build({
  entrypoints: [join(ROOT, "src", "client", "main.ts")],
  target: "browser",
  format: "esm",
  minify: true,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
await Bun.write(join(DIST, "app.js"), await result.outputs[0].text());
copyFileSync(join(ROOT, "src", "client", "styles.css"), join(DIST, "app.css"));

const out = renderDashboard();
console.log(`Wrote ${out}`);
if (process.argv.includes("--open")) open(out);

/** Opens a file in the desktop's browser: Windows and WSL through Explorer, else open/xdg-open. */
function open(file: string): void {
  if (process.platform === "win32") Bun.spawn(["explorer.exe", file]);
  else if (process.platform === "darwin") Bun.spawn(["open", file]);
  else if (process.env.WSL_DISTRO_NAME) {
    const win = spawnSync("wslpath", ["-w", file], { encoding: "utf8" }).stdout.trim();
    Bun.spawn(["explorer.exe", win || file]);
  } else Bun.spawn(["xdg-open", file]);
}
