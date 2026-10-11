import { build } from "esbuild";
import fs from "node:fs";

fs.rmSync(".test-build", { recursive: true, force: true });
await build({
  entryPoints: ["src/runtime.ts"], bundle: true, platform: "node", format: "esm",
  outfile: ".test-build/runtime.js", target: "node24", sourcemap: false,
});
await build({
  entryPoints: ["src/settings-actions.ts"], bundle: true, platform: "node", format: "esm",
  outfile: ".test-build/settings-actions.js", target: "node24", sourcemap: false,
});
